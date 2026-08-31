/**
 * BigQuery -> Supabase sync. Runs on a Vercel cron at 08:00 UTC.
 *
 * Target tables and their primary keys already exist and are not created or
 * altered here. Rows are upserted, then rows that no longer exist upstream are
 * swept, so each target ends the run as a mirror of its source. TRUNCATE is
 * never used: an upsert leaves no window where the table is empty, which
 * matters because these tables are read by live apps.
 *
 * Seven tables across three schemas -- b2b_metrics (Salesforce),
 * activity_report (Encompass + Salesforce) y org (roster de RRHH). El snapshot
 * de pipeline, que corre aparte al final, es el octavo destino.
 *
 * Order of operations is deliberate:
 *   1. authorize  2. freshness gate  3. write  4. sweep  5. verify by counting
 * The freshness gate runs before any write so stale BigQuery data can never
 * overwrite good rows -- keeping yesterday's data beats silently replacing it
 * with the day before's. Verification runs last so the counts reflect the
 * post-sweep state.
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getBigQueryClient, normalizeRow } from '@/lib/bigquery';
import { getSupabaseClient, TARGET_SCHEMA } from '@/lib/supabase-admin';
import {
  syncPipelineSnapshot,
  PIPELINE_SCHEMA,
  type PipelineSyncResult,
} from '@/lib/sync/pipelineSnapshot';

export const dynamic = 'force-dynamic';
// ~24,700 rows for leads_v2 alone; the default 15s ceiling is not enough.
export const maxDuration = 300;

const BATCH_SIZE = 500;
const MAX_DATA_AGE_HOURS = 30;

/**
 * Both guard lists are SCHEMA-QUALIFIED, and have to be.
 *
 * Since activity_report joined b2b_metrics, a bare table name no longer
 * identifies a table: two schemas can hold the same name and mean different
 * things. `activity_report.loan_records` is exactly the case that matters --
 * one letter and a suffix away from `loan_records_v2`, which this job does
 * write.
 */
function qualified(spec: Pick<TableSyncBase, 'schema' | 'target'>): string {
  return `${spec.schema ?? TARGET_SCHEMA}.${spec.target}`;
}

/**
 * Tables this job must never write to OR sweep. Both paths check this set, and
 * the write path asserts at request time.
 *
 *   b2b_metrics.master_assignments  18 rows with source='manual' -- human
 *                                   decisions with no upstream copy to rebuild
 *                                   from.
 *   activity_report.loan_records    la tabla que alimenta la app de actividad
 *                                   comercial hoy, cargada a mano desde un
 *                                   archivo. loan_records_v2 la reemplaza, pero
 *                                   la vieja queda intacta hasta que la app se
 *                                   cambie y se verifique. Grano distinto
 *                                   (préstamo x carga, no préstamo) y 23,584
 *                                   filas que este job no sabe reconstruir.
 */
const NEVER_WRITE = new Set([
  'b2b_metrics.master_assignments',
  'activity_report.loan_records',
]);

/**
 * The only tables the sweep may delete from. An allowlist rather than a
 * denylist: a table added to SYNCS later is not sweepable until it is named
 * here deliberately. NEVER_WRITE is still checked on top of this.
 */
const SWEEPABLE = new Set([
  'b2b_metrics.leads_v2',
  'b2b_metrics.opportunities_v2',
  'b2b_metrics.calls_daily',
  'b2b_metrics.dim_bd',
  'b2b_metrics.realtor_owner_map_v2',
  'activity_report.loan_records_v2',
  /*
   * ⚠ `org.roster_current` NO ESTÁ ACÁ, Y NO ES UN OLVIDO.
   *
   * El sweep borra las filas que no volvieron a aparecer arriba. Para las otras
   * seis tablas eso es exactamente lo que se quiere: son espejos de su fuente.
   * Para el roster, borrar a quien desapareció del archivo choca con dos cosas
   * que ya están decididas:
   *
   *   1. La baja es MANUAL, a pedido explícito de la usuaria: un archivo de
   *      RRHH incompleto desactivaría a quien sí está trabajando. Un sweep no
   *      la desactivaría -- la BORRARÍA, que es peor: se lleva su historia con
   *      ella.
   *
   *   2. La tabla tiene `left_detected_at`, una columna cuyo único sentido es
   *      registrar que alguien dejó de aparecer. Si el sweep borra esas filas,
   *      esa columna no se puede llenar nunca. La existencia de esa columna es
   *      la prueba de que el diseño espera que las filas SOBREVIVAN a la
   *      desaparición de la persona del archivo.
   *
   * Y hay un caso concreto que lo vuelve urgente: las personas con
   * `source_kind = 'user_addition'` --hoy dos-- son justamente las que RRHH no
   * tiene en sus archivos. Si la vista sale del archivo, el sweep las borraría
   * en cada corrida, y la pantalla las volvería a perder cada mañana.
   *
   * Sin esta entrada, `syncTable` avisa por consola ("not in SWEEPABLE,
   * skipping sweep") y sigue: hace el upsert y nada más, que es lo correcto
   * mientras la baja sea una decisión humana. Si algún día se quiere el sweep,
   * es agregar una línea acá -- pero antes hay que resolver los dos puntos de
   * arriba.
   */
]);

type TableSyncBase = {
  /** Label used in logs and in the response. */
  name: string;
  /** BigQuery source, dataset-qualified. */
  source: string;
  /** Supabase table. */
  target: string;
  /** Schema de `target`. Sin esto, `b2b_metrics`. */
  schema?: string;
  /** Column list for ON CONFLICT; comma-separated for composite keys. */
  conflict: string;
};

/**
 * A sync reads either a plain projection over `source` (`select`) or, when the
 * source needs real SQL to reach one row per conflict key, a full statement
 * (`query`). Exactly one of the two is set -- the union makes supplying both,
 * or neither, a type error rather than a runtime surprise.
 */
type TableSync =
  | (TableSyncBase & {
      /** Projection. Renames happen here in SQL rather than in JS. */
      select: string;
      query?: never;
    })
  | (TableSyncBase & {
      select?: never;
      /** Full SQL statement. Takes precedence over `select`. */
      query: string;
    });

/** Resolves a sync spec to the SQL actually sent to BigQuery. */
function buildQuery(spec: TableSync): string {
  if (spec.query) return spec.query;
  return `SELECT ${spec.select} FROM \`${spec.source}\``;
}

const SYNCS: TableSync[] = [
  {
    name: 'leads',
    source: 'b2b_marts.fct_leads',
    target: 'leads_v2',
    conflict: 'lead_id',
    select: [
      'lead_id',
      'referred_by',
      'lead_owner',
      'branch',
      'create_date',
      'first_name',
      'last_name',
      'lead_status',
      'converted',
      'realtor_key',
      'realtor_bd AS realtor_bd_name',
    ].join(', '),
  },
  {
    name: 'opportunities',
    source: 'b2b_marts.fct_opportunities',
    target: 'opportunities_v2',
    conflict: 'opportunity_id',
    select: [
      'opportunity_id',
      'opportunity_name',
      'created_date',
      'stage',
      'current_status',
      'current_milestone',
      'disbursement_date',
      'pre_approved_date',
      'ratified_date',
      'est_closing_date',
      'pre_qualified_date',
      'closed_won_date',
      'opportunity_owner',
      'loan_number',
      'loan_officer',
      'loan_amount',
      'total_loan_amount',
      'loan_status',
      'loan_folder',
      'branch',
      'account_name',
      'opportunity_team',
      'lender',
      'strategy',
      'healthiness',
      'referred_by',
      'realtor_key',
      'is_won',
      'excluded_from_metrics',
      'realtor_bd AS realtor_bd_name',
    ].join(', '),
  },
  {
    name: 'calls_daily',
    source: 'b2b_marts.fct_calls_daily',
    target: 'calls_daily',
    conflict: 'call_date,bd_id,record_type',
    select: [
      'call_date',
      'bd_id',
      'record_type',
      'total_calls',
      'effective_calls',
      'bd_name AS assigned_to',
    ].join(', '),
  },
  {
    name: 'dim_bd',
    source: 'b2b_marts.dim_bd',
    target: 'dim_bd',
    conflict: 'bd_id',
    select: ['bd_id', 'bd_name', 'bd_title', 'is_active'].join(', '),
  },
  {
    // All 15 columns are named identically on both sides, so they are copied
    // wholesale -- but the view is at recruitment-opportunity grain, not realtor
    // grain: 4,085 rows over 3,873 distinct realtor_keys. A key recurs with
    // *different* owners because different BDs worked that realtor at different
    // times. Upserting the raw view would make two rows in one batch hit the
    // same conflict key and Postgres would reject the whole batch.
    //
    // So collapse to one row per key, most recent first. "Most recent BD wins"
    // is deterministic, unlike the app's current dedupMap where whichever row
    // happens to land last in arbitrary file order wins.
    //
    // The date columns alone are not enough: 3 groups (6 rows) tie on both
    // leading dates, and 2 of them carry different owners, so ROW_NUMBER would
    // pick arbitrarily and those realtors would flip BD between runs. The view
    // exposes no unique id, so the tiebreak is built from the columns it has:
    // two more dates, then `owner` alphabetically. Alphabetical owner is
    // arbitrary as business logic but STABLE, which is the property that
    // matters -- a realtor lands on the same BD every run.
    //
    // ESTRATEGIA NPPM vs B2B. Las columnas `nppm` y `strategy` que trae el view
    // app_b2b_metrics.realtor_owner_map están mal: `nppm` marca 73 (cualquiera
    // con la casilla NPPM__c, sin exigir contratación) y `strategy` dice
    // 'B2B Strategy' en 64 de esos 73, contradiciéndose. La fuente correcta es
    // b2b_marts.dim_realtor_strategy (grano realtor_key, verificado 1-a-1), que
    // resuelve los 30 reales = 14 contratados (NPPM__c con StageName='Closed
    // Won') + 16 referidos (opp con Referred_By apuntando a un contratado; NO
    // llevan Closed Won). De ahí salen strategy / is_nppm_contracted /
    // is_nppm_referred / nppm_tipo / referred_by_nppm.
    //
    // Se descartan del view (EXCEPT) las dos columnas malas y se traen las
    // correctas por LEFT JOIN. COALESCE cubre keys del mapa que no estén en el
    // dim: por defecto B2B / no-NPPM. El dim es un row por realtor_key, así que
    // el JOIN no cambia el grano ya colapsado.
    //
    // TRANSICIÓN de la columna `nppm`: la app en vivo (MetricsHomesi) todavía
    // lee realtor_owner_map_v2.nppm para el chip NPPM de Meetings. Para no
    // romperla y a la vez dejar de mentir, `nppm` se sigue escribiendo pero
    // ahora = is_nppm_contracted (baja de 73 a 14, que es lo correcto). Cuando
    // la app migre a is_nppm_contracted se elimina la columna `nppm` en un
    // cambio aparte. `strategy` conserva el nombre; solo cambian sus valores.
    name: 'realtor_owner_map',
    source: 'app_b2b_metrics.realtor_owner_map',
    target: 'realtor_owner_map_v2',
    conflict: 'realtor_key',
    query: `
      SELECT
        m.* EXCEPT(rn, nppm, strategy),
        COALESCE(s.strategy, 'B2B')            AS strategy,
        COALESCE(s.is_nppm_contracted, FALSE)  AS is_nppm_contracted,
        COALESCE(s.is_nppm_referred, FALSE)    AS is_nppm_referred,
        s.nppm_tipo                            AS nppm_tipo,
        s.referred_by_nppm                     AS referred_by_nppm,
        COALESCE(s.is_nppm_contracted, FALSE)  AS nppm
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY realtor_key
          ORDER BY created_date DESC NULLS LAST,
                   meeting_attended_date DESC NULLS LAST,
                   invite_sent_date DESC NULLS LAST,
                   last_referral_date DESC NULLS LAST,
                   owner ASC
        ) AS rn
        FROM \`app_b2b_metrics.realtor_owner_map\`
      ) m
      LEFT JOIN \`b2b_marts.dim_realtor_strategy\` s USING (realtor_key)
      WHERE m.rn = 1
    `,
  },
  {
    /*
     * Actividad comercial. Primera tabla del job fuera de b2b_metrics.
     *
     * GRANO: un préstamo. Verificado contra la vista antes de escribir esto --
     * 4,779 filas, 4,779 loan_number distintos, ninguno nulo -- así que
     * loan_number sirve como clave de conflicto y ninguna tanda puede traer dos
     * filas que colisionen (el problema que tuvo realtor_owner_map).
     *
     * La vista expone 90 columnas; van las 36 que la tabla necesita, con los
     * renombres en SQL como en las demás. Los tipos se verificaron contra los
     * dos lados: las fechas son DATE en la vista y DATE en la tabla, no el
     * texto 'YYYY-MM' de la loan_records vieja, `closing_month` incluido.
     *
     * OJO AL AGREGAR: `counts_for_division` es la columna para totales de
     * división; `is_closed` es sólo para el detalle de una sucursal. Hoy la
     * diferencia son 5 préstamos -- 466 cerrados contra 461 que cuentan --
     * porque un HELOC de segundo gravamen le suma al loan officer y no a la
     * división. Usar is_closed en un agregado infla los cierres sin que nada
     * falle.
     */
    name: 'commercial_activity',
    source: 'lending_marts.fct_commercial_activity',
    target: 'loan_records_v2',
    schema: 'activity_report',
    conflict: 'loan_number',
    select: [
      'loan_number',
      'borrower_name',
      'loan_officer_name AS loan_officer',
      'loan_officer_person_code',
      'branch_code AS branch',
      'loan_amount AS total_loan_amount',
      'loan_program',
      'loan_type',
      'loan_channel',
      'loan_folder AS loan_folder_name',
      'lien_position',
      'ms_started AS file_creation_date',
      'credit_report_date',
      'application_date AS app_date',
      'closing_date',
      'closing_month',
      'is_closed',
      'counts_for_division',
      'is_second_lien_heloc',
      'strategy',
      'loan_officer_strategy',
      'has_salesforce',
      'realtor_bd AS bd',
      // La vista no expone is_b2b: se deriva de la estrategia, que ya resuelve
      // la precedencia Affinity > NPPM > Recruitment > B2B > Own Production.
      "strategy = 'B2B' AS is_b2b",
      'referred_by_realtor',
      'buyers_agent',
      'nppm_realtor',
      'realtor_es_nppm',
      'nppm_recruited_by',
      'opportunity_owner',
      'owner_title',
      'sf_stage',
      'branch_source',
      'branch_code_encompass AS branch_encompass',
      'is_affinity',
      'was_reclassified',
    ].join(', '),
  },
  {
    /*
     * Roster de RRHH, para la sección Admin de Commercial Activity. Primera
     * tabla del job en el schema `org`.
     *
     * GRANO: una persona. `person_code` es la PK de la tabla destino, así que
     * sirve de clave de conflicto y ninguna tanda puede traer dos filas que
     * colisionen. Son 108 personas: una sola tanda de las de 500.
     *
     * MAPEO: la vista trae los mismos nombres que la tabla. Las tres
     * diferencias, todas deliberadas:
     *
     *   hay_historia_de_cargas  NO se persiste. La calcula la vista y existe
     *                           sólo para que la pantalla sepa si mostrar "sin
     *                           registro" en las fechas. Guardar un valor
     *                           derivado sería tener dos verdades sobre lo
     *                           mismo, y la de la tabla envejecería.
     *   left_detected_at        la maneja la tabla, no viene de la vista.
     *   synced_at              lo escribe `syncTable` en cada fila.
     *
     * ⚠ `position` va entre backticks: es el nombre de una función de
     * BigQuery. Como referencia de columna no colisiona, pero citarlo cuesta
     * nada y saca la duda del medio.
     *
     * ⚠ NO TOCA `org.dim_employee`, que es otra tabla: tiene `employee_key`
     * generado, 378 alias que lo referencian y una FK con cascada.
     * `roster_current` no la reemplaza -- es de sólo lectura para Admin.
     */
    name: 'roster',
    source: 'hr_centralizado.roster_for_admin',
    target: 'roster_current',
    schema: 'org',
    conflict: 'person_code',
    select: [
      'person_code',
      'display_name',
      'name_in_file',
      'country',
      'branch_code',
      '`position`',
      'area',
      'supervisor',
      'supreme_email',
      'is_active',
      'source_kind',
      'has_override',
      'date_started',
      'first_seen_at',
      'last_seen_at',
      /*
       * Estado de la SUCURSAL, que no es el estado de la persona. Viajan en la
       * misma fila porque la pantalla de Admin agrupa por sucursal y necesita
       * las dos cosas, pero son independientes: hoy Robert Kravitz está activo
       * en la 709, que no lo está.
       *
       * `branch_is_active` no se deriva de la actividad -- es una decisión de
       * la usuaria, 15 sucursales de 27. Una cerrada puede tener préstamos en
       * vuelo y una nueva puede estar activa sin producir todavía.
       *
       * La vista hace COALESCE(b.is_active, FALSE), así que un `branch_code`
       * que no existe en `dim_branch_status` llega como inactivo y sin nota.
       * Es lo que pasa con el dato malo '700 - 707' (dos códigos en un campo).
       */
      'branch_is_active',
      'branch_note',
    ].join(', '),
  },
];

// MIN, not MAX: the most stale table gates the run. With MAX, one table
// syncing on time would mask another sitting three days behind, and the job
// would write those stale rows over good ones.
const FRESHNESS_QUERY = `
  SELECT MIN(last_modified_time) AS oldest_last_modified_time
  FROM salesforce.__TABLES__
  WHERE table_id IN ('Lead', 'Opportunity', 'Task', 'User')
`;

type TableResult = {
  tabla: string;
  filas_bigquery: number;
  filas_supabase: number | null;
  filas_borradas: number | null;
  coincide: boolean;
  duracion_ms: number;
  error: string | null;
  /** Sólo el pipeline: escribe tres tablas y un conteo solo no lo describe. */
  detalle?: PipelineSyncResult;
};

/** Constant-time compare so the secret cannot be recovered byte by byte. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed when unconfigured

  const provided = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Age of the *most stale* Salesforce -> BigQuery load, in hours.
 * Throws if the probe returns nothing, so an unanswerable freshness question
 * aborts the run rather than defaulting to "probably fine".
 */
async function getDataAgeHours(
  bq: ReturnType<typeof getBigQueryClient>,
): Promise<{ ageHours: number; lastModified: string }> {
  const [rows] = await bq.query({ query: FRESHNESS_QUERY });
  const raw = rows?.[0]?.oldest_last_modified_time;
  const ms = raw === null || raw === undefined ? NaN : Number(raw);

  if (!Number.isFinite(ms)) {
    throw new Error(
      'salesforce.__TABLES__ returned no last_modified_time for Lead/Opportunity/Task/User',
    );
  }

  return {
    ageHours: (Date.now() - ms) / 3_600_000,
    lastModified: new Date(ms).toISOString(),
  };
}

async function syncTable(
  spec: TableSync,
  bq: ReturnType<typeof getBigQueryClient>,
  sb: ReturnType<typeof getSupabaseClient>,
  syncedAt: string,
): Promise<TableResult> {
  const started = Date.now();

  const [rawRows] = await bq.query({ query: buildQuery(spec) });

  // synced_at is written explicitly on every row. A column DEFAULT now() only
  // fires on INSERT, so on an upsert that UPDATEs an existing row it would
  // never advance -- leaving the column useless and the sweep below unable to
  // tell a refreshed row from an abandoned one.
  const rows = rawRows.map((r) => ({ ...normalizeRow(r), synced_at: syncedAt }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from(spec.target)
      .upsert(batch, { onConflict: spec.conflict, ignoreDuplicates: false });

    if (error) {
      throw new Error(
        `upsert into ${spec.target} failed at row ${i}: ${error.message}`,
      );
    }
  }

  // --- Sweep rows that no longer exist upstream. ---
  // Every guard must hold. Reaching this line already means the write above
  // completed without error, since any failure threw.
  let filas_borradas: number | null = null;

  if (NEVER_WRITE.has(qualified(spec))) {
    throw new Error(`refusing to sweep protected table ${qualified(spec)}`);
  }

  if (rows.length === 0) {
    // A source returning zero rows is a source failure, not a mass deletion.
    // Sweeping here would empty the table on an upstream hiccup.
    console.warn(
      `[sync] ${spec.name}: source returned 0 rows, skipping sweep`,
    );
  } else if (!SWEEPABLE.has(qualified(spec))) {
    console.warn(`[sync] ${spec.name}: not in SWEEPABLE, skipping sweep`);
  } else {
    const { count: deleted, error: deleteError } = await sb
      .from(spec.target)
      .delete({ count: 'exact' })
      .lt('synced_at', syncedAt);

    if (deleteError) {
      throw new Error(
        `sweep of ${spec.target} failed: ${deleteError.message}`,
      );
    }
    filas_borradas = deleted ?? 0;
  }

  // Verify against the server rather than trusting that no error was thrown.
  // Runs after the sweep so the count reflects the final state.
  const { count, error: countError } = await sb
    .from(spec.target)
    .select('*', { count: 'exact', head: true });

  if (countError) {
    throw new Error(`count on ${spec.target} failed: ${countError.message}`);
  }

  const duracion_ms = Date.now() - started;
  console.log(
    `[sync] ${spec.name}: bq=${rows.length} supabase=${count} ` +
      `borradas=${filas_borradas ?? 'n/a'} ${duracion_ms}ms`,
  );

  return {
    tabla: qualified(spec),
    filas_bigquery: rows.length,
    filas_supabase: count ?? null,
    filas_borradas,
    coincide: count === rows.length,
    duracion_ms,
    error: null,
  };
}

export async function GET(req: NextRequest) {
  const started = Date.now();

  if (!isAuthorized(req)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const illegal = SYNCS.filter((s) => NEVER_WRITE.has(qualified(s)));
  if (illegal.length) {
    return Response.json(
      {
        ok: false,
        error: `refusing to run: protected table(s) targeted: ${illegal
          .map((s) => qualified(s))
          .join(', ')}`,
      },
      { status: 500 },
    );
  }

  let bq: ReturnType<typeof getBigQueryClient>;
  let sb: ReturnType<typeof getSupabaseClient>;
  try {
    bq = getBigQueryClient();
    sb = getSupabaseClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }

  // --- Freshness gate: nothing is written past this point if it fails. ---
  let freshness: { ageHours: number; lastModified: string };
  try {
    freshness = await getDataAgeHours(bq);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, aborted: true, stage: 'freshness_check', error: message },
      { status: 503 },
    );
  }

  if (freshness.ageHours > MAX_DATA_AGE_HOURS) {
    console.warn(
      `[sync] aborted: data is ${freshness.ageHours.toFixed(1)}h old`,
    );
    return Response.json(
      {
        ok: false,
        aborted: true,
        stage: 'freshness_check',
        error:
          `BigQuery data is ${freshness.ageHours.toFixed(1)}h old, over the ` +
          `${MAX_DATA_AGE_HOURS}h limit. Nothing was written.`,
        last_modified: freshness.lastModified,
        edad_horas: Number(freshness.ageHours.toFixed(2)),
        limite_horas: MAX_DATA_AGE_HOURS,
      },
      { status: 503 },
    );
  }

  // One timestamp for the whole run, taken before the first write. Every row
  // written this run carries it, and the sweep deletes anything older, so the
  // two halves cannot disagree about what "this run" means.
  const syncedAt = new Date().toISOString();

  // --- Write. One table failing must not stop the others. ---
  const resultados: TableResult[] = [];
  for (const spec of SYNCS) {
    try {
      // Un cliente por schema: `db.schema` se fija al construir y no se puede
      // cambiar por consulta. Vienen cacheados, así que esto no abre conexiones.
      resultados.push(await syncTable(spec, bq, getSupabaseClient(spec.schema), syncedAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sync] ${spec.name} failed: ${message}`);
      resultados.push({
        tabla: qualified(spec),
        filas_bigquery: 0,
        filas_supabase: null,
        filas_borradas: null,
        coincide: false,
        duracion_ms: 0,
        error: message,
      });
    }
  }

  /*
   * El pipeline va aparte del bucle porque no es una tabla espejo: escribe tres
   * tablas emparentadas y se reemplaza por día. Su resultado entra en la misma
   * lista para que una corrida se lea de una sola forma, y falla igual de
   * aislado que las demás -- que el pipeline se caiga no puede llevarse puestas
   * las seis anteriores, que ya escribieron bien.
   */
  const pipelineStarted = Date.now();
  try {
    const detalle = await syncPipelineSnapshot(bq);
    console.log(
      `[sync] pipeline: dia=${detalle.snapshot_date} snapshot=${detalle.snapshot_id} ` +
        `pipeline=${detalle.pipeline} resueltos=${detalle.resueltos} ` +
        `reemplazados=${detalle.snapshots_reemplazados}` +
        (detalle.omitido ? ` omitido=${detalle.omitido}` : ''),
    );
    resultados.push({
      tabla: `${PIPELINE_SCHEMA}.pipeline_snapshots (+loans, +resolved)`,
      filas_bigquery: detalle.filas_origen,
      filas_supabase:
        detalle.verificado === null
          ? null
          : (detalle.verificado.loans ?? 0) + (detalle.verificado.resolved ?? 0),
      filas_borradas: null,
      // Un día sin filas en la vista se omite a propósito y no es un desajuste.
      coincide: detalle.omitido !== null ? true : detalle.coincide,
      duracion_ms: Date.now() - pipelineStarted,
      error: null,
      detalle,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] pipeline failed: ${message}`);
    resultados.push({
      tabla: `${PIPELINE_SCHEMA}.pipeline_snapshots (+loans, +resolved)`,
      filas_bigquery: 0,
      filas_supabase: null,
      filas_borradas: null,
      coincide: false,
      duracion_ms: Date.now() - pipelineStarted,
      error: message,
    });
  }

  const fallidas = resultados.filter((r) => r.error !== null);
  const desajustadas = resultados.filter((r) => r.error === null && !r.coincide);

  // With the sweep in place the target is a mirror of the source, so a count
  // mismatch is a real defect rather than expected drift, and fails the run.
  const ok = fallidas.length === 0 && desajustadas.length === 0;

  return Response.json(
    {
      ok,
      duracion_total_ms: Date.now() - started,
      synced_at: syncedAt,
      last_modified: freshness.lastModified,
      edad_horas: Number(freshness.ageHours.toFixed(2)),
      tablas_ok: resultados.length - fallidas.length,
      tablas_fallidas: fallidas.map((r) => r.tabla),
      tablas_con_desajuste: desajustadas.map((r) => r.tabla),
      resultados,
    },
    { status: ok ? 200 : 500 },
  );
}
