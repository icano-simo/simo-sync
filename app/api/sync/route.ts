/**
 * BigQuery -> Supabase sync. Runs on a Vercel cron at 08:00 UTC.
 *
 * Target tables and their primary keys already exist and are not created or
 * altered here. Rows are upserted, then rows that no longer exist upstream are
 * swept, so each target ends the run as a mirror of its source. TRUNCATE is
 * never used: an upsert leaves no window where the table is empty, which
 * matters because these tables are read by live apps.
 *
 * Ten tables across three schemas -- b2b_metrics (Salesforce),
 * activity_report (Encompass + Salesforce, más el reclutamiento de Loan
 * Officers y la unión de los dos pipelines de contratación) y org (roster de
 * RRHH y tablero de contrataciones). El snapshot de pipeline, que corre aparte
 * al final y no usa `syncTable`, es el undécimo destino.
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
   * Espejo de Salesforce como leads y opportunities: nada de lo que hay acá lo
   * escribe una persona, así que una fila que desaparece arriba es una
   * oportunidad borrada y no una decisión que haya que conservar. Es lo que
   * separa este caso del roster, dos párrafos más abajo.
   *
   * Sin el sweep, una oportunidad borrada en Salesforce se quedaría acá para
   * siempre Y haría que el conteo no coincida, con lo cual la corrida ENTERA
   * fallaría todos los días hasta que alguien borrara la fila a mano.
   */
  'activity_report.lo_recruitment',
  /*
   * Espejo del tablero de contrataciones de RRHH en Monday. Una fila que
   * desaparece arriba es una contratación que RRHH quitó del tablero, no una
   * decisión que haya que preservar.
   *
   * ⚠ ES EXACTAMENTE LO CONTRARIO QUE `org.roster_current`, dos párrafos abajo,
   * y la diferencia no es de criterio sino de qué representa cada tabla. En el
   * roster, dejar de aparecer es un hecho sobre una PERSONA --se fue-- y se
   * marca para conservar su historia. Acá, dejar de aparecer es un hecho sobre
   * una FILA DE UN TABLERO que alguien mantiene a mano, y no hay nada que
   * conservar: si RRHH la quitó, no está.
   *
   * El barrido es además lo que hace que un nombre corregido arriba no deje un
   * duplicado. La clave de conflicto es el nombre (ver el spec), así que
   * arreglarle el doble espacio a 'Jorge  Betancur' crea una fila nueva; sin
   * barrido, la vieja se quedaría para siempre y el conteo no coincidiría nunca
   * más.
   */
  'org.hiring_tracking',
  /*
   * Espejo de la unión de los dos pipelines de contratación. Una fila que
   * desaparece arriba es alguien que entró al roster --y ahí lo cuenta el
   * roster, no esta tabla-- o un candidato que se cerró como perdido. En los
   * dos casos deja de ser un futuro Loan Officer, y conservarlo sería seguir
   * proyectando producción de alguien que ya no viene.
   */
  'activity_report.future_loan_officer',
  /*
   * ⚠ `org.roster_current` NO ESTÁ ACÁ, Y NO ES UN OLVIDO.
   *
   * El sweep borra las filas que no volvieron a aparecer arriba. Para las otras
   * nueve tablas eso es exactamente lo que se quiere: son espejos de su fuente.
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
    // correctas del dim. COALESCE deja en B2B / no-NPPM a las keys sin fila en
    // el dim (caso general).
    //
    // ⚠ FULL OUTER, no LEFT JOIN, y esto importa. Un realtor puede escribirse de
    // varias formas y cada tabla usa la suya: Daniella Ottone es 'daniela ottone'
    // en realtor_owner_map pero 'daniella ottone' (doble L) en fct_leads, donde
    // están sus 2.743 leads (la realtor NPPM de más volumen). El dim ahora emite
    // UNA FILA POR GRAFÍA (por eso pasó de 3.897 a ~4.024 claves): incluye las
    // grafías que solo viven en fct_leads/fct_opportunities. Con LEFT JOIN desde
    // el mapa esas grafías se perderían (el output quedaría keyado por el mapa) y
    // los leads de la grafía huérfana nunca cruzarían -> se contarían B2B. El
    // FULL OUTER une las claves de los dos lados: las del mapa traen owner/fechas,
    // las que solo están en el dim llegan con esas columnas en null (todas
    // nullable salvo realtor_key/synced_at, que tiene default) pero con su
    // strategy, para que leads/opps de cualquier grafía encuentren su estrategia.
    // El dim se deduplica por realtor_key (QUALIFY) por si una grafía se repite:
    // dos filas con la misma conflict key romperían el batch, igual que el mapa.
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
        COALESCE(m.realtor_key, s.realtor_key) AS realtor_key,
        m.realtor_name,
        m.owner,
        m.meeting_attended_date,
        m.invite_sent_date,
        m.last_referral_date,
        m.branch,
        m.loan_officers,
        m.opportunity_record_type,
        m.stage,
        m.created_date,
        m.recruitment_role,
        COALESCE(s.strategy, 'B2B')            AS strategy,
        COALESCE(s.is_nppm_contracted, FALSE)  AS is_nppm_contracted,
        COALESCE(s.is_nppm_referred, FALSE)    AS is_nppm_referred,
        s.nppm_tipo                            AS nppm_tipo,
        s.referred_by_nppm                     AS referred_by_nppm,
        COALESCE(s.is_nppm_contracted, FALSE)  AS nppm
      FROM (
        SELECT * EXCEPT(rn) FROM (
          SELECT * EXCEPT(nppm, strategy), ROW_NUMBER() OVER (
            PARTITION BY realtor_key
            ORDER BY created_date DESC NULLS LAST,
                     meeting_attended_date DESC NULLS LAST,
                     invite_sent_date DESC NULLS LAST,
                     last_referral_date DESC NULLS LAST,
                     owner ASC
          ) AS rn
          FROM \`app_b2b_metrics.realtor_owner_map\`
        ) WHERE rn = 1
      ) m
      FULL OUTER JOIN (
        SELECT realtor_key, strategy, is_nppm_contracted,
               is_nppm_referred, nppm_tipo, referred_by_nppm
        FROM \`b2b_marts.dim_realtor_strategy\`
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY realtor_key
          ORDER BY is_nppm_contracted DESC, is_nppm_referred DESC, nppm_tipo
        ) = 1
      ) s
      ON m.realtor_key = s.realtor_key
    `,
  },
  {
    /*
     * Actividad comercial. Primera tabla del job fuera de b2b_metrics.
     *
     * GRANO: un préstamo.
     *
     * INVARIANTE: COUNT(*) = COUNT(DISTINCT loan_number), ningún `loan_number`
     * nulo. Es lo que hace que sirva de clave de conflicto y que ninguna tanda
     * pueda traer dos filas que colisionen -- el problema que tuvo
     * realtor_owner_map. Comprobado el 2026-09-03 con 4,872 filas.
     *
     * La cantidad de préstamos sube con cada carga de Encompass, así que
     * verificarla contra un número fijo sólo produce falsas alarmas: eran 4,779
     * al escribir la primera versión de esta nota.
     *
     * La vista expone 90 columnas; van las 36 que la tabla necesita, con los
     * renombres en SQL como en las demás. Los tipos se verificaron contra los
     * dos lados: las fechas son DATE en la vista y DATE en la tabla, no el
     * texto 'YYYY-MM' de la loan_records vieja, `closing_month` incluido.
     *
     * OJO AL AGREGAR: `counts_for_division` es la columna para totales de
     * división; `is_closed` es sólo para el detalle de una sucursal.
     *
     * INVARIANTE: `counts_for_division` implica `is_closed`, nunca al revés --
     * o sea `COUNTIF(counts_for_division AND NOT is_closed) = 0`. Comprobado el
     * 2026-09-03. Los absolutos se mueven con cada carga (466 contra 461 al
     * escribir esto, 485 contra 480 el 2026-09-03), así que lo verificable es
     * la implicación y no la diferencia. Va en un sentido y no en el otro
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
      /*
       * En qué etapa quedó el préstamo, con once valores posibles.
       *
       * ⚠ NO SIRVE PARA DECIDIR SI UN PRÉSTAMO CERRÓ, y la tentación existe
       * porque los cierres se concentran en cuatro de esos valores -- Purchase
       * (388), Completion (50), Shipping (24) y Funding (7). Quien cierra lo
       * deciden `ms_funding` para Banked y `ms_completion` para Brokered, y eso
       * ya está resuelto en `is_closed` y `counts_for_division`, dos líneas más
       * arriba. Usar el milestone en su lugar sería una TERCERA regla para la
       * misma pregunta, y la que menos sabe de las tres: no distingue canal.
       *
       * Para qué sirve entonces: para ver dónde se detuvo lo que NO cerró. Los
       * 4.033 en 'Started' son préstamos que nunca avanzaron, y hoy eso no se
       * puede mirar desde Supabase.
       */
      'last_finished_milestone',
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
     * colisionen.
     *
     * INVARIANTE: COUNT(*) = COUNT(DISTINCT person_code), ningún `person_code`
     * nulo. El padrón crece y se encoge --altas, bajas, `user_addition`-- así
     * que el número del día no verifica nada; lo que no puede pasar es que dos
     * filas compartan la clave. Hoy entra en una sola tanda de las de 500.
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
      /*
       * Si `is_active` salió del archivo de RRHH o de una decisión a mano.
       *
       * Sin esto las dos se ven igual, y la diferencia es la que explica los
       * casos raros: Isabel Wagner y Ludwig Aguillon aparecen en el roster
       * porque el archivo los trae, pero están de baja. Con esta columna la
       * pantalla puede decir cuál de las dos cosas está mirando en vez de
       * mostrar un "activo" que nadie sabe de dónde salió.
       *
       * Gemela de `producer_set_by_hand`, más abajo, y por el mismo motivo.
       */
      'active_set_by_hand',
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
      /*
       * QUIÉN PRODUCE. Es lo que Business Plan y Outlook necesitan para saber
       * quién es Loan Officer, y lo que hoy deducen del cargo por su cuenta.
       *
       * ⚠ NO SE DERIVA DE LOS CIERRES, ni acá ni en la vista. Un Loan Officer
       * nuevo sin cierres todavía produce, y hay un NonProducing Branch Manager
       * con cero cierres que igual cuenta. La producción CONFIRMA la regla, no
       * la define -- derivarla de los cierres daría un roster que cambia solo
       * cada vez que alguien cierra su primer préstamo.
       *
       * La vista la saca del cargo y admite override por persona, porque el
       * cargo se equivoca en las dos direcciones: hay Production Managers que
       * producen y hay 'LO ASSISTANT' que sí y otros que no, con el mismo
       * título. `producer_set_by_hand` es lo que distingue "lo dice el cargo" de
       * "alguien lo decidió", y sin esa columna las dos se ven igual.
       */
      'is_producer',
      'producer_set_by_hand',
      /*
       * Está en el roster Y es realtor NPPM contratado: 7 personas. Su volumen
       * va a la estrategia NPPM del branch, así que el portal tiene que
       * listarlas en el desglose de estrategia y NO entre los Loan Officers.
       * Contarlas en los dos lados duplicaría el volumen del branch.
       */
      'is_nppm_realtor',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * RECLUTAMIENTO DE LOAN OFFICERS
     * ========================================================================
     *
     * El tercer pipeline de Salesforce que entra al job: los otros dos son
     * préstamos (`opportunities`) y realtors (`realtor_owner_map`). 26
     * columnas, todas con el mismo nombre de los dos lados.
     *
     * INVARIANTES, no conteos -- ver la nota de `hiring_tracking` sobre por qué:
     *
     *   COUNT(*) = COUNT(DISTINCT recruitment_id) y ningún `recruitment_id`
     *     nulo. Es lo que hace que sirva de clave de conflicto.
     *   `dias_abierto IS NOT NULL` exactamente cuando `is_open`. La vista lo
     *     deja nulo para los cerrados, así que una fila cerrada con días o una
     *     abierta sin ellos es un cambio de la vista, no un alta.
     *   `is_hired` implica `close_date IS NOT NULL`. Es la fecha de
     *     contratación real (ver abajo), así que un contratado sin ella
     *     rompería cualquier cuenta por mes.
     *   `is_hired`, `is_lost` e `is_open` son excluyentes: suman exactamente 1
     *     por fila.
     *
     * Comprobados los cuatro el 2026-09-03, con 234 filas.
     *
     * ⚠ LAS FECHAS DE ETAPA NO MIDEN TIEMPOS DE CICLO, y es la trampa más
     * probable de esta tabla. El conector no trae OpportunityHistory ni
     * OpportunityFieldHistory, así que no existe registro de cuándo un
     * candidato entró a una etapa. Lo único que hay son tres campos que alguien
     * llena a mano, y están llenos en menos de un tercio. Medido el 2026-09-02
     * sobre 233 filas -- son observaciones, no invariantes:
     *
     *   qualification_date   69 de 233
     *   proposal_date        62
     *   negotiation_date     59
     *
     * Una fecha ausente NO significa que la etapa no se alcanzó: significa que
     * nadie llenó el campo. Un "promedio de días entre etapas" calculado sobre
     * esto mide el hábito de carga de datos, no el proceso.
     *
     * ⚠ PARA "CUÁNTO LLEVA ABIERTO" VA `dias_abierto`, que la vista calcula
     * desde `created_date`. Que esté a medio poblar es correcto y no un campo a
     * medio llenar: la vista lo deja en NULL para los cerrados, así que está
     * exactamente en los abiertos. Ése es el invariante de arriba; el conteo
     * del día no dice nada.
     *
     * ⚠ LA FECHA DE CONTRATACIÓN ES `close_date`, NO `date_of_hire`.
     * `date_of_hire` estaba en 4 de 233 al 2026-09-02 -- nadie lo llena al
     * contratar. `close_date` está en TODAS las filas, y ningún contratado la
     * tiene vacía; eso último es el invariante de arriba.
     *
     * Otras dos casi vacías, para saberlo antes de construir encima, medidas el
     * 2026-09-02 sobre 233 filas: `licensed_states` (2) y `loan_volume_14m`
     * (18, de los cuales 16 son de los contratados).
     *
     * LA EMPRESA DEL CANDIDATO NO ESTÁ. No está en
     * `Broker_Company_Encompass__c` ni en `Referred_By_Company__c`: las dos
     * vienen vacías en TODAS las filas. Dónde se registra, si se registra, es una
     * pregunta abierta -- no hay que inventarle un campo.
     */
    name: 'lo_recruitment',
    source: 'lending_marts.fct_lo_recruitment',
    target: 'lo_recruitment',
    schema: 'activity_report',
    conflict: 'recruitment_id',
    /*
     * Las 26 se listan aunque los nombres coincidan de los dos lados. Con `*`,
     * una columna nueva en la vista viajaría sola y haría fallar el upsert
     * contra una tabla que no la tiene; con la lista, un renombre falla en
     * BigQuery diciendo qué columna no existe. El fallo ruidoso está del lado
     * correcto.
     */
    select: [
      'recruitment_id',
      'candidate_name',
      'recruiter',
      'stage',
      'current_status',
      'branch_code',
      'nmls_number',
      'licensed_states',
      'created_date',
      'qualification_date',
      'proposal_date',
      'negotiation_date',
      'close_date',
      'closed_won_date',
      'date_of_hire',
      'last_stage_change',
      'last_modified',
      'loan_volume_14m',
      'transactions_14m',
      'mmi_link',
      'reason_for_loss',
      'reason_for_loss_detail',
      'is_hired',
      'is_lost',
      'is_open',
      'dias_abierto',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * TABLERO DE CONTRATACIONES DE RRHH
     * ========================================================================
     *
     * Exportado de Monday y subido por la app de cargas. 39 filas, 23 columnas
     * más `synced_at`, todas con el mismo nombre de los dos lados. Segunda
     * tabla del job en el schema `org`.
     *
     * Las tres columnas de metadatos que escribe el cargador
     * --`upload_batch_id`, `uploaded_at`, `row_index`-- NO se sincronizan: la
     * vista las trae (26 columnas) y la tabla destino no las tiene. Sirven para
     * reconstruir la vista desde el stage, no para consultar el tablero.
     *
     * ------------------------------------------------------------------------
     * LA CLAVE DE CONFLICTO ES UN NOMBRE, Y ESO ES LO QUE HAY
     * ------------------------------------------------------------------------
     * El tablero no trae identificador. `nombre` es lo único estable, y es la
     * PK de la tabla destino.
     *
     * INVARIANTE: COUNT(*) = COUNT(DISTINCT nombre) y ningún `nombre` nulo ni
     * vacío. Ninguna tanda puede traer dos filas que colisionen.
     *
     * Si dos personas tuvieran el mismo nombre se pisarían, y el síntoma sería
     * que el conteo no coincide --38 filas en Supabase contra 39 en BigQuery--
     * no un error. Hoy no pasa. Cuando pase, la salida no es cambiar la clave
     * acá sino conseguir un identificador arriba.
     *
     * ⚠ EL NOMBRE VIENE COMO LO ESCRIBIERON: 'Jorge  Betancur' trae DOS
     * ESPACIOS. Es la clave, así que corregirlo en el tablero no edita la fila
     * -- crea una nueva y el barrido se lleva la vieja. Para un espejo eso es
     * correcto, pero no hay que confundirlo con "se duplicó".
     *
     * ------------------------------------------------------------------------
     * LA REGLA QUE IMPORTA: `cuenta_como_proximo_ingreso`
     * ------------------------------------------------------------------------
     * Cuentan como próximo ingreso SÓLO los de la sección 'New Hire' que NO
     * están en el roster.
     *
     * ⚠ UNA VEZ QUE ALGUIEN LLEGA AL ROSTER, EL ROSTER MANDA. Aunque el tablero
     * lo siga listando, y aunque el roster lo marque inactivo después. Aparecer
     * en el roster significa que entró; el tablero describe lo que va a pasar y
     * el roster lo que pasó. Sumar a alguien que ya entró lo contaría dos veces:
     * una como persona del roster y otra como ingreso pendiente.
     *
     * De ahí que 14 filas tengan `es_nuevo` y sólo 6 cuenten: la diferencia son
     * las canceladas y las de la sección 'Completed New Hire'.
     *
     * Hoy son 6, y el cargo decide dónde va cada uno en el portal:
     *
     *   Jose Flores, Victoria Zambrano    Loan Officer -- van a producir
     *   Leonel Turcios, Jorge Betancur,
     *     Albeiro Lopera                  Business Development -- estrategia NPPM
     *   Mayra Tipacti                     LO Assistant
     *
     * ------------------------------------------------------------------------
     * DOS COSAS DEL DATO QUE NO SON ERRORES
     * ------------------------------------------------------------------------
     *   is_cancelled     7 filas. El marcador viene DENTRO del nombre
     *                    ('... - Cancelled'), no en una columna de estado, y la
     *                    vista lo saca del nombre para que la clave no lo
     *                    lleve. Se conservan porque una contratación cancelada
     *                    es información. No cuentan como próximo ingreso.
     *   cruzo_por_alias  7 filas. El tablero escribe el nombre legal completo
     *                    donde el roster usa la forma corta, y eso sólo se
     *                    salva con `hr_centralizado.person_alias_manual`. Sin
     *                    esos alias, cuatro personas que SÍ están en el roster
     *                    parecían faltantes -- o sea, contarían como próximos
     *                    ingresos cuando ya entraron.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos. RRHH agrega y quita gente del tablero todo el
     * tiempo, así que "39 filas" falla el día que entra alguien -- y falla
     * pareciendo un problema del mapeo, que es lo peor de los dos mundos.
     * Cada uno se escribe como `COUNTIF(...) = 0`:
     *
     *   COUNT(*) = COUNT(DISTINCT nombre), sin nulos ni vacíos.
     *   `cuenta_como_proximo_ingreso` = (`seccion` = 'New Hire' AND
     *     `person_code` IS NULL AND NOT `is_cancelled`) en TODA fila. Es la
     *     regla escrita como comprobación: si deja de valer, la vista cambió.
     *   De ahí salen las dos que importan y no hay que recordar: nadie cuenta
     *     como próximo ingreso estando ya en el roster, ni estando cancelado.
     *   `es_nuevo` = (`person_code` IS NULL) en TODA fila. Es lo que impide
     *     confundir `es_nuevo` con `cuenta_como_proximo_ingreso`.
     *   El conteo de Supabase contra el de BigQuery, que `syncTable` ya
     *     compara y devuelve en `coincide`.
     *
     * Comprobados los cuatro el 2026-09-03, con 39 filas: 6 próximos ingresos
     * y 7 canceladas. Esos dos números son la foto de ese día, no el criterio.
     */
    name: 'hiring_tracking',
    source: 'hr_centralizado.hr_hiring_tracking',
    target: 'hiring_tracking',
    schema: 'org',
    conflict: 'nombre',
    /*
     * Las 23 se listan aunque los nombres coincidan de los dos lados, igual que
     * en `lo_recruitment`: con `*` viajarían también las tres de metadatos y el
     * upsert fallaría contra una tabla que no las tiene.
     */
    select: [
      'nombre',
      'seccion',
      // El nombre tal como está en el tablero, con el '- Cancelled' incluido.
      // `nombre` es la versión limpia; ésta es la que se busca en Monday.
      'nombre_en_el_tablero',
      'is_cancelled',
      'cargo',
      // Del tablero, no del roster: para quien todavía no entró no hay otro.
      'branch_en_el_tablero',
      'manager',
      'hr_rep',
      'region',
      'employment_status',
      'rehire',
      'fecha_inicio',
      // Los seis pasos del alta. Texto libre del tablero, no booleanos.
      'new_hire_packet_sent',
      'completed_new_hire_packet_received',
      'background_check',
      'nmls_access',
      'i_9_documents',
      'complete',
      'notes',
      // NULL cuando la persona no está en el roster, que es justo el caso que
      // `cuenta_como_proximo_ingreso` selecciona.
      'person_code',
      'cruzo_por_alias',
      'es_nuevo',
      'cuenta_como_proximo_ingreso',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * FUTUROS LOAN OFFICERS
     * ========================================================================
     *
     * Los dos pipelines de contratación unidos: el tablero de RRHH
     * (`org.hiring_tracking`, origen 'hr_pipeline') y el reclutamiento de
     * Salesforce (`activity_report.lo_recruitment`, origen 'salesforce'). 19
     * filas, 20 columnas más `synced_at`.
     *
     * POR QUÉ HACE FALTA ESTA Y NO ALCANZA CON LAS DOS QUE YA ESTÁN: cada una
     * tiene un solo lado y sus propias reglas. La vista las une y ya aplica el
     * corte de un año en Closed Won, la exclusión de quienes ya están en el
     * roster, el descarte de la marca (DUPLICATE) antes de comparar nombres, y
     * el marcador de branch para quien no tiene uno asignado. Rehacer eso del
     * lado del portal sería tener dos versiones de las mismas reglas.
     *
     * Clave de conflicto `nombre`, que es la PK del destino. Mismo razonamiento
     * --y mismo límite-- que en `hiring_tracking`: arriba no hay identificador
     * único que cruce los dos orígenes. El invariante está abajo.
     *
     * ------------------------------------------------------------------------
     * ⚠ PARA PROYECTAR VA `producira`, NO EL CONTEO DE PERSONAS
     * ------------------------------------------------------------------------
     * De los 19, sólo 15 producen. Los 4 que no: 3 de Business Development
     * --que es estrategia NPPM del branch y no producción propia, ver
     * `es_nppm`-- y 1 LO Assistant. Contar filas proyectaría 19 originadores
     * donde hay 15.
     *
     * Los 4 caen todos en `confianza = 'confirmado'`: de esos 6, sólo 2
     * producen. Filtrar por confianza sin filtrar por `producira` es el error
     * más fácil de cometer acá.
     *
     * ------------------------------------------------------------------------
     * ⚠ `confianza` TIENE CUATRO VALORES Y EL ÚLTIMO NO SIRVE PARA PROYECTAR
     * ------------------------------------------------------------------------
     *   confirmado  6   del tablero de RRHH, con fecha de inicio
     *   ganado      1   Closed Won reciente que no llegó al roster
     *   probable    8   Negotiation con menos de 180 días
     *   tentative   4   más de 180 días -- HOY ENTRE 323 Y 811 DÍAS
     *
     * Los `tentative` no son pipeline: son candidatos que nadie cerró.
     * Proyectar sobre ellos infla el pronóstico. Verificado que los cuatro
     * valores son los únicos que aparecen.
     *
     * ------------------------------------------------------------------------
     * ⚠ `dias_abierto` SIGNIFICA TRES COSAS DISTINTAS SEGÚN LA FILA
     * ------------------------------------------------------------------------
     * Es la trampa menos visible de esta tabla, porque el nombre suena a una
     * sola cosa y la columna es un entero en todas:
     *
     *   origen 'salesforce', abierto   días que el candidato lleva abierto
     *                                  (hoy 21 a 811)
     *   origen 'salesforce', ganado    NULL -- ya cerró
     *   origen 'hr_pipeline'           días respecto de `fecha_inicio`, y
     *                                  NEGATIVO si todavía no empezó
     *
     * Verificado: en las 6 filas de 'hr_pipeline' el valor es exactamente
     * `DATE_DIFF(CURRENT_DATE(), fecha_inicio, DAY)`. Victoria Zambrano tiene
     * -11 porque empieza el 14 de septiembre.
     *
     * Consecuencias, las dos concretas: un promedio o un MIN sobre las 19
     * filas mezcla unidades y se come el negativo sin avisar; y el corte de 180
     * días que define `tentative` sólo tiene sentido para las de Salesforce.
     * Cualquier cuenta con esta columna se parte por `origen` primero.
     *
     * ------------------------------------------------------------------------
     * ⚠ `branch_code = 'Recruitment'` ES UN MARCADOR, NO UN BRANCH
     * ------------------------------------------------------------------------
     * Hay candidatos de Salesforce sin branch usable. Al 2026-09-03 son cinco:
     * tres dicen literalmente 'Recruitment', uno trae 'KGFR82' de la era City
     * Lending y uno viene vacío. Todos quedan con `branch_code = 'Recruitment'`
     * y `sin_branch_asignado = true` -- las dos cosas marcan LAS MISMAS filas,
     * y eso sí es invariante (está abajo); cuántas son cambia.
     *
     * Se conservan VISIBLES en vez de descartarse: no tener branch asignado es
     * un dato sobre el proceso de contratación, no un motivo para desaparecer.
     * Pero agrupar por `branch_code` sin excluirlos inventa un branch llamado
     * 'Recruitment' con cinco personas. `branch_en_la_fuente` guarda lo que
     * decía el origen, para poder rastrear de dónde salió cada uno.
     *
     * ------------------------------------------------------------------------
     * `era_duplicado` HOY ES false EN LAS 19
     * ------------------------------------------------------------------------
     * Marca a quien venía con la marca (DUPLICATE) en el nombre, que la vista
     * descarta antes de comparar. Que hoy no haya ninguno no significa que la
     * columna sobre: significa que la limpieza de arriba está al día. No se
     * puede validar contra el dato mientras siga en cero.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos: los dos pipelines de arriba se mueven solos, así
     * que "19 filas" o "15 producen" fallan con cualquier alta legítima. Cada
     * uno se escribe como `COUNTIF(...) = 0`:
     *
     *   COUNT(*) = COUNT(DISTINCT nombre), sin nulos ni vacíos.
     *   `confianza` sólo toma los cuatro valores conocidos, y `origen` sólo
     *     'hr_pipeline' o 'salesforce'. Un valor nuevo cambia cómo se proyecta
     *     y no debería aparecer sin que nadie lo note.
     *   `es_nppm` implica NOT `producira`. Es la regla del punto 1 escrita como
     *     comprobación: un NPPM que produzca duplicaría el volumen del branch.
     *   `sin_branch_asignado` = (`branch_code` = 'Recruitment') en TODA fila.
     *     Si se separan, o hay un branch real llamado 'Recruitment' o hay
     *     alguien sin branch que el marcador no marcó.
     *   `origen` = 'hr_pipeline' implica `fecha_inicio IS NOT NULL`.
     *   `dias_abierto`, por origen y sólo por origen:
     *       'hr_pipeline'          = DATE_DIFF(CURRENT_DATE(), fecha_inicio, DAY)
     *       'salesforce', ganado   IS NULL
     *       'salesforce', abierto  IS NOT NULL
     *     Es el invariante que sostiene la advertencia de las tres unidades: si
     *     deja de valer, la columna cambió de significado en silencio.
     *   El conteo de Supabase contra el de BigQuery, que `syncTable` ya compara
     *     y devuelve en `coincide`.
     *
     * Comprobados todos el 2026-09-03, con 19 filas: 15 `producira`, 3
     * `es_nppm`, 5 `sin_branch_asignado` y confianza en 6/1/8/4. Esos números
     * son la foto de ese día, no el criterio.
     */
    name: 'future_loan_officer',
    source: 'lending_marts.fct_future_loan_officer',
    target: 'future_loan_officer',
    schema: 'activity_report',
    conflict: 'nombre',
    // Las 20 listadas, no `*`: ver la nota de `lo_recruitment`.
    select: [
      // 'hr_pipeline' o 'salesforce'. Hace falta para leer `dias_abierto`.
      'origen',
      'nombre',
      'nombre_normalizado',
      // El nombre tal como lo escribe Salesforce, cuando la fila viene de ahí.
      'nombre_en_salesforce',
      'era_duplicado',
      'stage',
      'current_status',
      'recruiter',
      // Salesforce. La fecha de contratación de un Closed Won.
      'close_date',
      'cargo',
      // 'Recruitment' cuando no hay branch usable. Ver la nota de arriba.
      'branch_code',
      'branch_en_la_fuente',
      'sin_branch_asignado',
      // Tablero de RRHH. Las 6 de 'hr_pipeline' la tienen; las de Salesforce no.
      'fecha_inicio',
      'dias_abierto',
      'nmls_number',
      // El id en su origen: recruitment_id de Salesforce, o el nombre del tablero.
      'id_fuente',
      'confianza',
      'producira',
      'es_nppm',
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
