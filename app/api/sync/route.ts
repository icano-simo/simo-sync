/**
 * BigQuery -> Supabase sync. Runs on a Vercel cron at 08:00 UTC.
 *
 * Target tables and their primary keys already exist and are not created or
 * altered here. Rows are upserted, then rows that no longer exist upstream are
 * swept, so each target ends the run as a mirror of its source. TRUNCATE is
 * never used: an upsert leaves no window where the table is empty, which
 * matters because these tables are read by live apps.
 *
 * Fifteen tables across four schemas -- b2b_metrics (Salesforce),
 * activity_report (Encompass + Salesforce, más el reclutamiento de Loan
 * Officers y la unión de los dos pipelines de contratación), org (roster de
 * RRHH, tablero de contrataciones, nombres de loan officer resueltos y los
 * realtors del programa NPPM) y comp (comisiones y horas). El snapshot de
 * pipeline, que corre aparte al final y no usa `syncTable`, es el decimosexto
 * destino.
 *
 * ⚠ ESTE CONTEO SE DESACTUALIZA. Decía once cuando ya había catorce specs: las
 * de `person_name_key`, `loan_commission` y `hours_logged` entraron sin tocarlo.
 * Si no coincide con `SYNCS.length`, el número está viejo y no hay ninguna tabla
 * escondida.
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
// El límite de frescura ya no es uno solo: vive en FRESHNESS, por grupo. Las 30
// horas de Salesforce siguen siendo las mismas, ahora en FRESHNESS.core.

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

/** El grupo de un spec, con `core` por defecto. */
function groupOf(spec: Pick<TableSyncBase, 'group'>): SyncGroup {
  return spec.group ?? 'core';
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
   * Espejo de las grafías de loan officer que trae Encompass. Un nombre que
   * desaparece arriba es un loan officer que ya no aparece en el export, y esta
   * tabla no guarda nada propio: sus doce columnas son todas derivadas.
   *
   * ⚠ NO CONFUNDIR CON EL ROSTER, dos párrafos abajo. Acá el grano es UNA
   * GRAFÍA, no una persona: si una grafía deja de usarse, lo que se va es una
   * forma de escribir un nombre, y la persona sigue en `roster_current` con su
   * `person_code`. Ahí sí, borrar sería perder a alguien.
   */
  'org.loan_officer_resolved',
  /*
   * Las tres de Compensafe. Espejos de archivos que alguien sube: nada de lo
   * que hay acá lo escribe una persona DENTRO de esta base, así que una fila
   * que desaparece arriba es una línea que ya no está en el archivo y no una
   * decisión que haya que conservar.
   *
   * El riesgo propio de una fuente por archivos --que una carga parcial borre
   * lo que no trae-- lo cubre la guarda de `rows.length > 0`, que salta el
   * barrido cuando el origen devuelve cero, más la puerta de frescura del grupo
   * `comp`, que impide escribir con un archivo viejo.
   *
   * ⚠ `payroll_transaction` ES LA QUE MÁS NECESITA EL BARRIDO, y por una razón
   * que las otras dos no tienen: su clave incluye `amount` y la descripción.
   * Corregir un importe arriba no actualiza la fila -- crea una nueva, porque
   * la clave cambió. Sin barrido quedarían las dos, el pago viejo y el
   * corregido, sumando los dos en la misma persona.
   */
  'comp.loan_commission',
  'comp.hours_logged',
  'comp.payroll_transaction',
  /*
   * Espejo de los realtors del programa NPPM. Una fila que desaparece arriba es
   * alguien que salió del programa, y esta tabla no guarda nada propio: sus
   * trece columnas son todas derivadas.
   *
   * ⚠ NO CONFUNDIR CON `org.roster_current`, acá abajo. Un realtor NPPM no es
   * empleado por serlo --hay contratados que además están en el roster, y quien
   * está en proceso todavía no--, así que acá no hay historia laboral que
   * perder: lo que el barrido se lleva es la ficha del programa, no la persona.
   */
  'org.nppm_realtor',
  /*
   * ⚠ `org.roster_current` NO ESTÁ ACÁ, Y NO ES UN OLVIDO.
   *
   * El sweep borra las filas que no volvieron a aparecer arriba. Para las otras
   * trece tablas eso es exactamente lo que se quiere: son espejos de su fuente.
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
  /**
   * Qué puerta de frescura gobierna esta tabla. Sin esto, `core`.
   *
   * No es una etiqueta: decide qué sonda decide si la tabla se escribe, y por
   * eso una tabla nueva hereda `core` en vez de quedarse sin puerta.
   */
  group?: SyncGroup;
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
     * ------------------------------------------------------------------------
     * LA IDENTIDAD DEL REALTOR NPPM: `nppm_realtor_code`, NO EL NOMBRE
     * ------------------------------------------------------------------------
     * ⚠ LA FUENTE SIGUE SIENDO `fct_commercial_activity`, LA VISTA BASE, y no
     * una de sus variantes. Las tres columnas aparecieron primero en
     * `_v2` y ahora están también en la base, que es superset de aquélla.
     *
     * Apuntar a `_v2` habría funcionado igual, y aun así es peor: `_v2` y
     * `_nppm` son duplicaciones pendientes de consolidar, así que un spec
     * apuntado a una de ellas hay que migrarlo cuando desaparezcan. La base es
     * el único nombre que no se va a mover.
     *
     * `nppm_realtor` llega CRUDO de Salesforce, sin normalizar en ningún punto
     * de la cadena: hay 'FRED A GOMEZ' en mayúsculas con inicial del medio al
     * lado de nombres en formato normal, y 'Jose Boggio' contra 'Jose A Boggio'
     * en el mismo préstamo. Agrupar por ese texto parte a una persona en varias.
     *
     * Las tres columnas van juntas y NINGUNA SOBRA:
     *
     *   nppm_realtor_code      la clave estable. Sale de
     *                          `lending_marts.dim_nppm_realtor_v2` y no cambia
     *                          nunca -- ni cuando la persona entra al roster ni
     *                          cuando alguien corrige la grafía arriba. Es lo
     *                          único por lo que se joinea.
     *   nppm_display_name      el nombre para mostrar, el de la dimensión y no
     *                          el crudo. Guardar el crudo reproduciría el
     *                          desorden que el código vino a resolver.
     *   nppm_realtor_efectivo  el nombre con el COALESCE ya aplicado. Es el que
     *                          `outlook.nppm_benchmark` necesita para su
     *                          `nppm_realtor`, que sigue siendo NOT NULL, y el
     *                          que permite reconocer una fila si hay que
     *                          auditar. Usar `nppm_realtor` para eso dejaría
     *                          vacías las tres filas del respaldo.
     *
     * ⚠ EL CÓDIGO SE RESUELVE DEL COALESCE, NO DE `nppm_realtor` A SECAS. Tres
     * préstamos del branch 733 --dos de Santiago Jaraba Chacon y uno de Ana
     * Hardy-- tienen `nppm_realtor` vacío y su realtor en
     * `referred_by_realtor`. Los tres resuelven. Si el código saliera del campo
     * principal a secas, esos tres caerían en 'unassigned realtor' SIN QUE NADA
     * FALLE, deshaciendo la regla de respaldo que el portal ya tenía.
     *
     * ------------------------------------------------------------------------
     * ⚠ EL CÓDIGO NO ES LA PERTENENCIA, Y CONFUNDIRLOS YA COSTÓ UNA REGRESIÓN
     * ------------------------------------------------------------------------
     * Son dos preguntas distintas y hay dos columnas porque hacen falta las dos:
     *
     *   nppm_realtor_code   ¿QUIÉN es este realtor? Lo tienen TODOS, sea o no
     *                       del programa. Sale de `dim_realtor_code`, que es la
     *                       autoridad del código y no filtra por nada.
     *   nppm_is_member      ¿ADEMÁS está en el programa NPPM? Sale de
     *                       `dim_nppm_realtor_v2`, que es el padrón del
     *                       programa y se mueve: gente que entra, y gente que
     *                       sale por cancelarse su contratación.
     *   nppm_estado         'contratado' o 'en proceso', y sólo cuando
     *                       pertenece.
     *
     * Al 2026-09-16: 275 filas con código, 92 con pertenencia. O sea 183 filas
     * cuyo realtor tiene código y NO es del programa -- y ésa es exactamente la
     * población que desaparece si se confunden.
     *
     * ⚠ QUÉ PASÓ EL 15 DE SEPTIEMBRE, porque el error es fácil de repetir. La
     * dimensión del programa se usó como autoridad del código, así que resolver
     * el código quedó condicionado a pertenecer. Resultado: los préstamos de
     * realtors de afuera perdieron el código y la resolución cayó de 92/94 a
     * 85/95, con Jose Boggio --que SÍ es del programa-- perdiendo el suyo por un
     * `match_key` que dejó de cruzar. Separadas las dos vistas, hoy son 95 de
     * 95.
     *
     * NO FILTRAR EL CÓDIGO POR LA PERTENENCIA. Agrupar producción va por código;
     * saber si esa persona está en el programa va por `nppm_is_member`. Un
     * `false` ahí no es un hueco: es un realtor que trabajó con la división sin
     * estar en el programa, y hoy son seis préstamos de estrategia NPPM.
     *
     * INVARIANTES de estas dos, comprobados el 2026-09-16:
     *   `nppm_is_member` implica `nppm_realtor_code IS NOT NULL` -- pertenecer
     *     sin tener código sería un defecto de la separación.
     *   `nppm_estado IS NOT NULL` coincide EXACTAMENTE con `nppm_is_member`: el
     *     estado sale del programa, así que sin pertenencia no hay estado.
     *   `nppm_is_member` implica `nppm_display_name IS NOT NULL`.
     *
     * ⚠ `nppm_estado` HOY SÓLO TOMA 'contratado', y no hay ninguna fila con 'en
     * proceso' -- ni acá ni en `org.nppm_realtor`. El único que lo tenía,
     * Albeiro Lopera, salió del programa porque su contratación se canceló. El
     * valor sigue siendo válido: simplemente no hay nadie.
     *
     * Que un valor no esté en el dato no significa que no exista. Acotar un
     * filtro a lo que hoy aparece deja afuera a la primera persona que vuelva a
     * estar en proceso.
     *
     * INVARIANTE: `nppm_realtor_code IS NOT NULL` implica
     * `nppm_display_name IS NOT NULL` -- un código sin nombre para mostrar
     * dejaría la pantalla en blanco.
     *
     * ⚠ Y HAY DOS CONTEOS DE `nppm_realtor_code`, NO UNO. Los dos son correctos
     * y confundirlos hace parecer que la resolución se rompió:
     *
     *   COUNT(*) WHERE nppm_realtor_code IS NOT NULL             todas las filas
     *                                                            que traen
     *                                                            realtor
     *   COUNT(*) WHERE strategy = 'NPPM' AND code IS NOT NULL     sólo las de
     *                                                            esa estrategia
     *
     * La diferencia son préstamos de OTRAS estrategias cuyo realtor igual es un
     * NPPM: el código se resuelve para cualquier fila que traiga realtor, no
     * sólo para las de esa estrategia. Al 2026-09-16 son 275 y 95.
     *
     * Cuando la vista se reescribió, el conteo amplio apareció donde antes se
     * miraba el acotado y por un momento pareció que los nombres se habían
     * vuelto a partir: más realtors para los mismos préstamos baja el promedio
     * por persona, y en pantalla eso se lee como productividad repartida. No era
     * eso: eran dos medidas distintas. **El que sirve para juzgar la RESOLUCIÓN
     * es el acotado a la estrategia.**
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
      /*
       * LA IDENTIDAD DEL REALTOR NPPM, resuelta arriba. Las cinco van juntas y
       * ninguna sobra -- ver la nota del spec.
       *   nppm_realtor_efectivo  el nombre con el COALESCE ya aplicado
       *   nppm_realtor_code      la clave estable, y la unica que se joinea
       *   nppm_display_name      el nombre para mostrar
       *   nppm_is_member         si ademas pertenece al programa
       *   nppm_estado            contratado / en proceso, cuando pertenece
       */
      'nppm_realtor_efectivo',
      'nppm_realtor_code',
      'nppm_display_name',
      'nppm_is_member',
      'nppm_estado',
      'realtor_es_nppm',
      'nppm_recruited_by',
      'opportunity_owner',
      'owner_title',
      /*
       * Si el dueño de la oportunidad es un Business Developer.
       *
       * La columna "BD owner" de Loan Count sacaba `bd` --el BD asignado AL
       * REALTOR, cruzado por la clave del realtor-- y de la mayoria de los 183
       * prestamos que mostraba era falso. El prestamo 770002068892 enseñaba
       * "Andres Zorro", que no lo trajo: lleva a su realtor.
       *
       * Con esto la columna muestra `opportunity_owner` solo cuando es true.
       * Pasa de 183 valores a 126, y los 126 si son del prestamo: los 282
       * restantes son "sf integrations", que no es una persona.
       *
       * ⚠ VIAJA AUNQUE HOY SEA DERIVABLE de owner_title = 'Business Developer'
       * --coinciden exacto, 126 cierres y las mismas siete personas--. Comparar
       * el titulo en la app seria inferir esta logica desde una foto: el dia
       * que el origen contemple un titulo nuevo o un roster de BD activos, la
       * comparacion de cadena se quedaria atras SIN FALLAR, y la unica señal
       * seria un BD que desaparece de una pantalla.
       */
      'owner_es_bd',
      'sf_stage',
      'branch_source',
      'branch_code_encompass AS branch_encompass',
      'is_affinity',
      'was_reclassified',
      /*
       * ────────────────────────────────────────────────────────────────────
       * DOCE COLUMNAS PARA LOAN COUNT (homesi-pl), 2026-09-13
       * ────────────────────────────────────────────────────────────────────
       * Doce y no trece: `loan_program` ya viajaba con las 41 anteriores. La
       * tabla pasa de 41 a 53 columnas.
       * Loan Count deja de contar sobre un archivo que alguien sube y pasa a
       * contar sobre esta tabla. El archivo se habia quedado atras: agosto de
       * 2026 tiene 47 cierres aquí y CERO allí.
       *
       * ⚠ AÑADIR, NUNCA QUITAR NI RENOMBRAR EN ESTA LISTA. `loan_records_v2` la
       * lee tambien el portal de actividad comercial; sumar columnas es
       * aditivo y seguro, tocar las que ya estaban no lo es.
       *
       * Lo que estas trece responden y las 41 anteriores no:
       *   de que tipo es el prestamo   loan_purpose, lead_source
       *   quien mas trabajo en el      los cinco roles ademas del LO
       *   que margen dejo              las cinco de puntos
       *
       * DELIBERADAMENTE FUERA la cadena de hitos completa -- los ocho ms_*,
       * uw_decision, uw_submitted_date, uw_suspended_date. Son once columnas de
       * fechas para medir tiempos de ciclo, y eso es otra pantalla: un conteo
       * no las usa. Estan en la vista cuando hagan falta.
       */
      'loan_purpose',
      /*
       * El origen del lead, de Encompass.
       *
       * Sustituye a `lead_source_lo` del archivo, y esto se verifico antes de
       * decidirlo: son el mismo campo con los mismos valores -- Friends and
       * Family, Self-Generated, Transition, Marketing, In-House, Management
       * Referral, Internet, y hasta la misma grafia rara "ILG - In - House".
       * El archivo traia ademas cuatro valores que la fuente no usa (Encompass
       * Integration 47, B2B Strategy 4, Referral 3, External Referral 3) y 46
       * vacios: residuos de captura. La fuente es la version limpia.
       */
      'lead_source',
      // Los cinco roles que faltaban. `loan_officer_name` ya viaja arriba como
      // `loan_officer`; estos cinco no tenian columna y por eso no se podia
      // saber quien mas toco un prestamo.
      'loan_processor_name',
      'underwriter_name',
      'loan_closer_name',
      'lo_assistant_1_name',
      'lo_assistant_2_name',
      /*
       * El margen del prestamo en PUNTOS, tal como lo calcula Encompass.
       *
       * ⚠ NO CONFUNDIR CON EL MARGEN DEL P&L. Esto es lo que dice el sistema de
       * originacion sobre el prestamo; el P&L de homesi-pl tiene sus propias
       * cuentas de margen (Back-end, Front-end, Discount Income) que salen de
       * la contabilidad y viven en otra tabla. Son dos medidas de cosas
       * parecidas por caminos distintos, y no tienen por que coincidir: usar
       * una donde se espera la otra da un numero plausible y equivocado.
       */
      'back_end_margin_pts',
      'origination_points',
      'concessions_pts',
      'total_branch_margin_pts',
      'lender_credit_usd',
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
       *
       * ⚠ EL EJEMPLO QUE ESTABA ACÁ NO SE SOSTIENE. Decía que eso es lo que
       * pasa con el dato malo '700 - 707' (dos códigos en un campo, en
       * `hr_centralizado.dim_employee_co`). Medido el 2026-09-13: NINGUNO de
       * los 114 `branch_code` de `org.roster_current` lleva guion ni espacio,
       * así que ese valor no llega acá. O la vista lo normaliza, o esa persona
       * es una de las dos que no llegan -- `dim_employee_co` trae 45 de
       * Colombia y acá entran 43, y no se determinó qué las filtra.
       *
       * Las dos cosas se arreglan en `hr_centralizado`, no en este job. Quedan
       * anotadas, con la tercera, en el comentario de `org.roster_current`:
       * ver docs/sql/2026-09-13-roster-override-comentarios.sql.
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
     * LAS GRAFIAS DE CADA PERSONA
     * ========================================================================
     *
     * Todas las maneras de escribir el nombre de alguien, contra su
     * `person_code`. La vista une SIETE fuentes: display, legal_co, hr_usa,
     * directory, salesforce, loan_officer y el implícito del correo.
     *
     * GRANO: una grafía por fuente, no una persona. Por eso la clave de
     * conflicto son las TRES columnas: la misma grafía puede llegar por dos
     * fuentes --"Ana Peña" está en display y en directory-- y son dos hechos
     * distintos sobre la misma persona.
     *
     * INVARIANTE: ningún `person_code` ni `name_key` nulo. La vista ya descarta
     * los nombres vacíos, así que un nulo aquí sería un cambio de la vista.
     * Medido el 2026-09-14: 523 filas, 111 personas, 7 fuentes. Dos tandas.
     *
     * PARA QUE: el módulo de P&L por Loan Officer de homesi-pl cruza la nómina
     * del P&L --texto libre, "LAINO CHEGWIN, GIAN L"-- con las personas. Esta
     * tabla aporta lo que ninguna normalización de texto puede deducir: que
     * "steve badovinac" y "steven badovinac" son la misma persona.
     *
     * ⚠ NO ES UN SUPERCONJUNTO DE `roster_current`, y confundirlo cuesta caro.
     * `dim_person`, su base, tiene 111 personas; `roster_current` 114 y
     * `dim_employee` 127. Son poblaciones distintas: 18 de los 46 loan officers
     * de finance_division.loan_officials NO ESTÁN en dim_person. Medido, sobre
     * esos 46: esta tabla sola resuelve 28, la normalización de texto sola 31,
     * y unidas 34. Quien retire las otras fuentes creyendo que ésta las
     * reemplaza pierde 18 personas, y el síntoma --"sin nómina localizada"-- se
     * lee como un hallazgo del negocio y no como una regresión del código.
     *
     * ⚠ SIN `group`, o sea `core`, IGUAL QUE EL ROSTER. Deliberado: viene del
     * mismo `hr_centralizado` y se consume junto al roster, así que las dos
     * tienen que envejecer a la vez. Darle puerta propia permitiría que una
     * estuviera fresca y la otra no, y entonces habría gente en el roster cuyas
     * grafías todavía no han llegado.
     *
     * ⚠ `name_key` YA VIENE NORMALIZADA de la vista --NFD, sin diacríticos,
     * minúsculas, todo lo que no sea [a-z ] a espacio, colapsado-- y NO se
     * vuelve a tocar aquí. `lib/lo-payroll-name.ts` de homesi-pl replica esa
     * misma normalización para poder comparar. Si la vista cambia la suya, hay
     * que cambiar la de allí: dos normalizaciones distintas dan dos claves que
     * no casan nunca, y eso no falla -- devuelve "no localizado" para todos.
     */
    name: 'person_name_key',
    source: 'hr_centralizado.person_name_key',
    target: 'person_name_key',
    schema: 'org',
    conflict: 'person_code,name_key,src',
    select: ['person_code', 'name_key', 'src'].join(', '),
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
     * ------------------------------------------------------------------------
     * ⚠ SI LA CLAVE SE REPITE EN UNA TANDA, EL UPSERT FALLA ASÍ
     * ------------------------------------------------------------------------
     *   upsert into hiring_tracking failed at row 0:
     *   ON CONFLICT DO UPDATE command cannot affect row a second time
     *
     * Postgres rechaza la tanda ENTERA y no escribe nada. Es ruidoso y es lo
     * correcto: pisar una fila con otra en silencio sería peor.
     *
     * ⚠ Y LA CAUSA CASI SEGURO NO SON DOS PERSONAS CON EL MISMO NOMBRE. Pasó el
     * 2026-09-16 y el error se leía como homónimos, pero era otra cosa: el
     * tablero se había cargado DOS VECES --el 3 y el 15 de septiembre-- y la
     * vista sumaba los dos lotes en vez de quedarse con el último. Cada persona
     * aparecía una vez por carga.
     *
     * Antes de buscar homónimos, mirar cuántos `upload_batch_id` trae la vista.
     * Si es más de uno, el arreglo es filtrar al último lote arriba, no cambiar
     * la clave acá. El mismo defecto estaba en `fct_production_payroll` y
     * `fct_payroll_transaction`.
     *
     * Si alguna vez SÍ fueran dos personas distintas con el mismo nombre, ahí sí
     * la salida es conseguir un identificador arriba -- pero ése es el segundo
     * sospechoso, no el primero.
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
     * ⚠ Y HEREDA SU MODO DE FALLA, porque lee de esa misma vista. El 2026-09-16
     * las dos fallaron con «ON CONFLICT DO UPDATE command cannot affect row a
     * second time» por el mismo lote duplicado: el tablero cargado dos veces y
     * la vista sumando los dos. Ver la nota de `hiring_tracking` -- el primer
     * sospechoso es el conteo de `upload_batch_id`, no los homónimos. Ésta se
     * arregló sola al arreglarse aquélla.
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
  {
    /*
     * ========================================================================
     * NOMBRES DE LOAN OFFICER, RESUELTOS
     * ========================================================================
     *
     * 72 grafías crudas de Encompass que colapsan a 43 personas. 13 columnas
     * más `synced_at`. Tercera tabla del job en el schema `org`.
     *
     * ------------------------------------------------------------------------
     * POR QUÉ EXISTE: HABÍA DOS TABLAS DE EQUIVALENCIAS DESINCRONIZÁNDOSE
     * ------------------------------------------------------------------------
     *   hr_centralizado.person_name_key   523 grafías / 111 personas  canónica
     *   org.employee_alias (Supabase)     378 / 127                   por detrás
     *
     * La de Supabase se llenaba A MANO, fila por fila, y cada grafía nueva se
     * descubría sólo cuando algo no resolvía. Con esta tabla la app recibe el
     * `person_code` ya resuelto y no empareja por nombre en ningún punto.
     *
     * TRES CASOS QUE LA JUSTIFICAN, y ninguno falla de forma visible:
     *
     *   Ana Manjarres   Salesforce escribe 'Manjarrez' con Z y el roster
     *                   'Manjarres' con S. Una vista de Forecast la partió en
     *                   dos filas.
     *   Susan Aguilar   'Susan  Aguilar' con DOBLE ESPACIO y 'Susan Aguilar':
     *                   dos filas para una persona, 13 préstamos repartidos.
     *   Karen De Fex    'De Fex' y 'de Fex', 407 filas.
     *
     * Los tres producen números plausibles y equivocados: una persona partida
     * en dos suma igual en el total y aparece dos veces en el detalle.
     *
     * ------------------------------------------------------------------------
     * LA CLAVE ES LA GRAFÍA, NO LA PERSONA, Y ES A PROPÓSITO
     * ------------------------------------------------------------------------
     * El grano de esta tabla es UNA GRAFÍA CRUDA, así que la clave de conflicto
     * es `loan_officer_name`. `match_key` NO puede serlo: es justamente lo que
     * comparten las grafías de una misma persona, así que las dos filas de
     * Susan Aguilar colisionarían en la misma tanda y Postgres rechazaría el
     * batch entero -- el problema que ya tuvo `realtor_owner_map`.
     *
     * Por eso 72 filas y no 43: Susan aporta dos, y eso no es un duplicado a
     * limpiar. Es el mapa de las formas en que Encompass escribe los nombres, y
     * su utilidad depende de que estén TODAS.
     *
     * ⚠ Y ES LO QUE HAY QUE CUIDAR AL CONSUMIRLA. Que el grano sea la grafía
     * decide cómo se cuenta:
     *
     *   unir `loan_records_v2` por `loan_officer_name`   BIEN. Una fila por
     *                                                    nombre, sin abanicar.
     *   COUNT(*) sobre esta tabla                        cuenta GRAFÍAS, no
     *                                                    personas: hoy daría 72
     *                                                    loan officers donde
     *                                                    hay 43.
     *   COUNT(DISTINCT person_code)                      así se cuentan
     *                                                    personas.
     *
     * El error no avisa: 72 es un número plausible para "cuántos loan officers
     * hay", y es el mismo tipo de falla que la tabla vino a arreglar -- una
     * persona contada dos veces. Sólo que del otro lado.
     *
     * ⚠ Y PARA FILTRAR ACTIVOS VA `is_active`, NO `es_de_la_division`. Son dos
     * preguntas distintas y hay una fila que las separa: Isabel Wagner es de la
     * división --tiene `person_code`, 13 préstamos y 2 cierres-- y ya no está en
     * el roster. Un scorecard de loan officers activos que filtre por
     * `es_de_la_division` la incluye; uno que filtre por `is_active` no.
     *
     * Las tres columnas contestan tres cosas que conviene no mezclar:
     *   es_de_la_division        ¿es nuestra, o de otro branch de Supreme?
     *   is_active               ¿trabaja hoy acá?
     *   ya_no_esta_en_el_roster  ¿trabajaba y se fue? -- lo que distingue eso de
     *                            "nunca estuvo", que es el caso de las 28.
     *
     * ------------------------------------------------------------------------
     * ⚠ UN `person_code` NULL NO ES UN ERROR
     * ------------------------------------------------------------------------
     * Encompass trae loan officers de todos los branches de Supreme, así que 28
     * de las 72 grafías son PERSONAS REALES FUERA DE LA DIVISIÓN. No tienen
     * `person_code` porque no están en nuestro roster, y eso es correcto.
     *
     * `es_de_la_division` dice cuáles son cuáles, y EL SYNC NO LAS FILTRA: se
     * cargan las 72. Filtrar acá dejaría a la app sin poder distinguir un
     * nombre mal escrito de un loan officer de otro branch -- dos problemas
     * distintos con dos respuestas distintas.
     *
     * ⚠ ES LO CONTRARIO DE `roster_us`, donde el filtro de división SÍ va en el
     * cargador. Allá se filtran FILAS DE PERSONAS que no deben entrar a
     * BigQuery; acá se conserva un MAPA DE NOMBRES cuyo valor está en ser
     * completo. La diferencia no es de criterio sino de qué es cada fila.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos: Encompass agrega grafías cada vez que alguien
     * escribe un nombre distinto, así que "72 filas" falla con la primera
     * variante nueva -- y falla pareciendo un problema del mapeo.
     *
     *   COUNT(*) = COUNT(DISTINCT loan_officer_name), sin nulos ni vacíos. Es
     *     lo que hace que sirva de clave de conflicto.
     *   `es_de_la_division` = (`person_code` IS NOT NULL) en TODA fila. Si se
     *     separan, o hay alguien de la división sin resolver o se le asignó un
     *     `person_code` a alguien de afuera.
     *   Cada `match_key` tiene UN SOLO `person_code` distinto. Dos personas
     *     detrás de la misma clave de emparejamiento es el bug que esta tabla
     *     viene a evitar, no uno que pueda tolerar.
     *   `nombre_canonico` poblado en TODA fila con `person_code`. Es el que
     *     atrapó dos defectos seguidos -- ver abajo.
     *   `branch_del_roster`, `cargo` y las tres banderas, pobladas donde hay
     *     `person_code` Y NOT `ya_no_esta_en_el_roster`. Ésas SÍ salen del
     *     roster, y quien ya salió no las tiene.
     *   `ya_no_esta_en_el_roster` implica `person_code IS NOT NULL`: la columna
     *     dice que la persona se fue, no que no se la reconoce.
     *   El conteo de Supabase contra el de BigQuery, que `syncTable` ya compara.
     *
     * ------------------------------------------------------------------------
     * ⚠ `nombre_canonico` ATRAPÓ DOS DEFECTOS, Y EL SEGUNDO ERA UN RESPALDO QUE
     * NO RESPALDABA
     * ------------------------------------------------------------------------
     * La misma persona los provocó los dos: Isabel Wagner, que tiene 13
     * préstamos y 2 cierres y salió del roster, así que `roster_for_admin` ya no
     * la nombra.
     *
     *   1. El invariante estaba MAL ESCRITO. Pedía las seis columnas del roster
     *      pobladas donde hubiera `person_code`, y eso no es cierto para quien
     *      salió: no tiene branch ni cargo. Tal como estaba habría fallado
     *      siempre y se habría aprendido a ignorarlo. Se desdobló: sólo
     *      `nombre_canonico` se exige en toda fila con código; las otras cinco,
     *      acotadas a `NOT ya_no_esta_en_el_roster`.
     *   2. El respaldo de `nombre_canonico` NO HACÍA NADA. Caía a
     *      `dim_person_all`, que --contra lo que decía esta nota-- NO conserva a
     *      quienes salen. O sea que el respaldo apuntaba al mismo lugar vacío:
     *      Isabel seguía con `nombre_canonico` NULL y rompió una pantalla de
     *      Forecast. Ahora cae a LA GRAFÍA QUE RESOLVIÓ, que siempre existe
     *      porque es la fila misma.
     *
     * LA LECCIÓN DEL SEGUNDO: un respaldo hacia una fuente que tiene el mismo
     * hueco que la principal no es un respaldo. El invariante es lo que lo
     * distingue de uno que sí funciona, porque los dos se ven igual en el código.
     * Éste es exactamente el que habría detectado el defecto antes de que
     * llegara a una pantalla.
     *
     * Al 2026-09-16: 87 filas, 56 con `person_code`, 1 con
     * `ya_no_esta_en_el_roster` --Isabel Wagner-- y cero violaciones de los
     * cuatro invariantes. Eran 72 y 44 ocho días antes: Encompass agrega grafías
     * cada vez que alguien escribe un nombre distinto, así que estos números son
     * la foto del día y no el criterio.
     *
     * Comprobado el 2026-09-09: las columnas coinciden exactas entre la vista y
     * el destino y en el mismo orden, sin renombres; la tabla tiene su PK sobre
     * `loan_officer_name`, `service_role` con DELETE --que el barrido
     * necesita-- y `authenticated` con SELECT. Los cuatro invariantes de arriba
     * pasan sobre las 72 filas.
     */
    name: 'loan_officer_resolved',
    source: 'lending_marts.dim_loan_officer_resolved',
    target: 'loan_officer_resolved',
    schema: 'org',
    conflict: 'loan_officer_name',
    // Las 13 listadas, no `*`: ver la nota de `lo_recruitment`.
    select: [
      // La grafía cruda de Encompass. Es la clave.
      'loan_officer_name',
      // Lo que comparten las grafías de una misma persona. NO es la clave.
      'match_key',
      'prestamos',
      'cierres',
      // NULL en las 28 de fuera de la división. No es un error.
      'person_code',
      // Las seis del roster: pobladas sólo donde hay `person_code`.
      'nombre_canonico',
      'branch_del_roster',
      'cargo',
      'is_active',
      'is_producer',
      'is_nppm_realtor',
      // Lo único que distingue "no resuelve" de "no es nuestro".
      'es_de_la_division',
      // Y lo único que distingue "ya no está" de "nunca estuvo". Ver la nota.
      'ya_no_esta_en_el_roster',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * COMISIÓN POR PRÉSTAMO -- COMPENSAFE
     * ========================================================================
     *
     * Primera tabla del job fuera de Salesforce/Encompass/RRHH: viene de
     * archivos de Compensafe. Primera del schema `comp`, y primera del grupo de
     * frescura `comp`.
     *
     * GRANO: un préstamo.
     *
     * INVARIANTE: COUNT(*) = COUNT(DISTINCT loan_number), ningún nulo.
     * Comprobado el 2026-09-12 con 361 filas: 361 distintos, 0 nulos. Es lo que
     * hace que `loan_number` sirva de clave sin colapsar nada y que ninguna
     * tanda pueda traer dos filas que colisionen.
     *
     * PARA QUÉ SE TRAE: para que el P&L pueda decir, por préstamo, cuánto se le
     * pagó al loan officer. Hoy la app no tiene ese dato y por eso el mini P&L
     * por loan officer estaba bloqueado.
     *
     * CRUZA CON EL P&L POR `loan_number` Y SIN TRANSFORMAR NADA -- ni formatos,
     * ni nombres. Medido sobre una muestra de 170 de los 361: 160 existen en
     * `loan_officials` y 160 tienen revenue en `pl_transactions`, 94% por los
     * dos lados. Los 10 que no cruzan son de sucursales fuera de la división o
     * anteriores al rango del P&L, y se muestran como lo que son.
     *
     * ⚠ NO TRAE `person_code`, Y NO HACE FALTA. La vista expone `lo_emp_no`,
     * que es un id estable, y el cruce con el P&L es por `loan_number`, que es
     * exacto. Agrupar por `lo_name` sería volver a emparejar nombres a mano --
     * exactamente lo que esta fuente vino a evitar. Y no serviría de todos
     * modos: de los 34 loan officers de esta vista, sólo 15 alcanzan un
     * `person_code` a través de `hours_logged`.
     *
     * `upload_batch_id` y `uploaded_at` NO se sincronizan, igual que en
     * `hiring_tracking`: describen la carga del archivo al stage, no el
     * préstamo. Para "de cuándo es este dato" está `synced_at`.
     */
    name: 'loan_commission',
    source: 'comp_marts.fct_loan_commission',
    target: 'loan_commission',
    schema: 'comp',
    conflict: 'loan_number',
    group: 'comp',
    // Las 15 listadas, no `*`: con `*` viajarían también las dos de metadatos y
    // el upsert fallaría contra una tabla que no las tiene.
    select: [
      'loan_number',
      'borrower',
      'completed_date',
      'lo_name',
      'lo_emp_no',
      'processor_name',
      'branch_manager_name',
      'loan_amount',
      'lo_pay',
      'processor_pay',
      'bm_pay',
      'other_pay',
      // Viene calculado de arriba. No se recalcula acá: sería una segunda
      // verdad capaz de discrepar con la vista.
      'total_pay',
      'lo_effective_bps',
      'total_effective_bps',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * HORAS REGISTRADAS -- COMPENSAFE
     * ========================================================================
     *
     * Quién registró horas en cada periodo, y cuánto se le pagó por ellas. 448
     * filas, 39 empleados, de agosto 2025 a agosto 2026.
     *
     * ------------------------------------------------------------------------
     * ⚠ LA CLAVE LLEVA `pay_date`, Y SIN ÉL EL LOTE ENTERO SE CAE
     * ------------------------------------------------------------------------
     * Medido el 2026-09-12:
     *
     *   448 filas
     *   334 distintas por (person_code, periodo)       -> 114 colisiones
     *   359 distintas por (emp_no, periodo)            ->  89 colisiones
     *   448 distintas por (emp_no, periodo, pay_date)  <- y sin nulos
     *
     * Los 78 grupos repetidos se separan LOS 78 por `pay_date`; ninguno por
     * sucursal y ninguno queda idéntico en todo. UN PERIODO DE HORAS PUEDE
     * PAGARSE EN DOS FECHAS, y eso es el dato, no un duplicado que limpiar.
     *
     * Sin `pay_date` en la clave, dos filas de la misma tanda colisionan y
     * Postgres rechaza el batch ENTERO -- el problema que ya tuvo
     * `realtor_owner_map`. Ahí hizo falta colapsar con QUALIFY; acá no, porque
     * la clave completa ya es única y no hay nada que descartar.
     *
     * ------------------------------------------------------------------------
     * ⚠ LA CLAVE USA `emp_no`, NO `person_code`
     * ------------------------------------------------------------------------
     * 34 filas -- 9 de las 39 personas -- no tienen `person_code`:
     * `hr_centralizado.person_name_key` no las resuelve. Una clave primaria con
     * nulos no existe, así que `person_code` viaja como columna y no como
     * identidad.
     *
     * Que falte para 9 personas es un hueco de la FUENTE y se muestra como tal.
     * Rellenarlo acá emparejando nombres reconstruiría a mano lo que esta
     * fuente vino a reemplazar.
     *
     * ------------------------------------------------------------------------
     * ⚠ LA CLAVE COMPUESTA SE CAYÓ, Y POR QUÉ AHORA ES SINTÉTICA
     * ------------------------------------------------------------------------
     * Todo lo de arriba sigue siendo cierto sobre qué distingue una fila -- pero
     * la clave NO puede ser esa combinación, y el 2026-09-16 la corrida lo
     * mostró:
     *
     *   hours_logged failed: null value in column "hours_period_from" of
     *   relation "hours_logged" violates not-null constraint
     *
     * `hours_period_from` PUEDE FALTAR: 4 filas de 731 traen una descripción que
     * no sigue el patrón "Hours entered from M.D.YY to M.D.YY", así que no hay
     * de dónde sacar las fechas. Una columna que puede ser NULL no puede ser
     * clave primaria, y por esas cuatro filas se caía la carga ENTERA.
     *
     * La fuente pasa a `comp_marts.hours_logged_v`, que agrega `hours_key`: una
     * clave sintética, calculada ARRIBA. Las dos fechas quedan nullables en el
     * destino y viajan como columnas.
     *
     * ⚠ SE CALCULA EN LA VISTA Y NO EN EL JOB, a propósito. Una clave calculada
     * acá existiría sólo en Supabase --no se podría joinear desde BigQuery ni
     * comprobar un invariante sobre ella-- y, lo que decide: podría DIVERGIR DE
     * SÍ MISMA. Si alguien cambiara cómo se compone, las filas viejas quedarían
     * con la clave vieja, el upsert dejaría de encontrarlas e insertaría
     * duplicados en vez de actualizar. Con la clave en la vista, un cambio así
     * se ve como un barrido y el conteo cuadra.
     *
     * ⚠ Y LO QUE HACE QUE FUNCIONE PARA LAS CUATRO ES UN `COALESCE` A CADENA
     * VACÍA. Sin él, concatenar un NULL daría NULL en toda la expresión --o sea
     * que la clave sería nula justo en las filas que causaron el problema-- y el
     * arreglo no arreglaría nada.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos: sube un archivo y las 731 dejan de ser 731.
     *
     *   COUNT(*) = COUNT(DISTINCT hours_key), sin nulos ni cadenas vacías. Es
     *     lo único que hace de clave; si deja de valer, el upsert empieza a
     *     pisar datos.
     *   `emp_no` y `pay_date` sin nulos. Son los dos componentes que SIEMPRE
     *     están, y de los que la clave depende para distinguir filas.
     *   Que `hours_period_from` y `hours_period_to` falten NO es un defecto: es
     *     una descripción que no sigue el patrón. Verificarlas como obligatorias
     *     es lo que rompió la carga.
     *   El conteo de Supabase contra el de BigQuery, que `syncTable` compara.
     *
     * Al 2026-09-16: 731 filas, 731 claves distintas, ninguna nula ni vacía, 4
     * sin periodo.
     */
    name: 'hours_logged',
    source: 'comp_marts.hours_logged_v',
    target: 'hours_logged',
    schema: 'comp',
    conflict: 'hours_key',
    group: 'comp',
    select: [
      // La clave, calculada en la vista. Ver la nota de arriba.
      'hours_key',
      'emp_no',
      // Pueden faltar --4 de 731-- y por eso ya no son parte de la clave.
      'hours_period_from',
      'hours_period_to',
      'pay_date',
      // Resuelto arriba contra hr_centralizado. NULL para 9 de 39 personas.
      'person_code',
      'person_name',
      // El nombre como venía en el archivo, antes de resolver.
      'employee_in_file',
      'branch_code',
      'paid_amount',
      'recaptured_amount',
      'net_amount',
      'had_recapture',
      'lines',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * NÓMINA LÍNEA A LÍNEA -- COMPENSAFE
     * ========================================================================
     *
     * Tercera de Compensafe, y la que abre el total que las otras dos dejan
     * cerrado. GRANO: UNA LÍNEA de nómina. 1.859 al 2026-09-16.
     *
     * PARA QUÉ SE TRAE: en el P&L por Loan Officer, "Loan officer payroll" es
     * hoy una sola cifra --la suma de las cuentas 60105, 60115 y 60117-- que
     * contesta cuánto se le pagó a alguien y no contesta por qué. Compensafe sí
     * lo sabe:
     *
     *     Commission            549 líneas     1.288.545
     *     Other                 760 líneas     1.241.645
     *     Bonus                 264 líneas       574.391
     *     Earnings Recapture    252 líneas      -203.614
     *     Override               34 líneas        39.412
     *
     * Las horas solas son 1,24 millones, casi tanto como las comisiones.
     *
     * ------------------------------------------------------------------------
     * ⚠ LA FUENTE ES UNA VISTA QUE TODAVÍA NO EXISTE, Y ESO BLOQUEA ESTE SPEC
     * ------------------------------------------------------------------------
     * `comp_marts.fct_payroll_transaction` NO TRAE NINGUNA COLUMNA QUE SIRVA DE
     * CLAVE -- ni transaction_id ni número de línea. Hace falta una sintética, y
     * por el precedente de `hours_logged` SE CALCULA ARRIBA, en una vista
     * `fct_payroll_transaction_v`, no acá.
     *
     * La razón está escrita en el spec de al lado y vale igual: una clave
     * calculada en el job existiría sólo en Supabase --no se podría joinear
     * desde BigQuery ni comprobar un invariante sobre ella-- y podría DIVERGIR
     * DE SÍ MISMA. Si alguien cambiara cómo se compone, las filas viejas
     * quedarían con la clave vieja, el upsert dejaría de encontrarlas e
     * insertaría duplicados en vez de actualizar.
     *
     * La vista tiene que exponer `txn_key` así, y medido: 1.859 valores
     * distintos sobre 1.859 filas.
     *
     *   CONCAT(
     *     emp_no, '|', CAST(pay_date AS STRING), '|', pay_type, '|',
     *     COALESCE(loan_number, ''), '|', COALESCE(description, ''), '|',
     *     CAST(amount AS STRING)
     *   ) AS txn_key
     *
     * ⚠ EL `COALESCE` NO ES DEFENSIVO, ES LO QUE HACE QUE FUNCIONE. Es la misma
     * lección de `hours_logged_v`, y acá pega mucho más fuerte: allá fallaban 4
     * filas de 731 por una descripción rara; acá `loan_number` ES NULO EN LA
     * MAYORÍA DE LAS LÍNEAS -- Bonus, las horas, casi todo lo que no es
     * comisión. Concatenar un NULL da NULL en toda la expresión, así que sin
     * COALESCE la clave sería nula en más de la mitad de la tabla.
     *
     * ⚠ Y HAY QUE COMPROBAR QUE `description` NO CONTENGA `|`. Es texto libre:
     * un `|` dentro movería el troceo y dos filas distintas podrían producir la
     * misma clave. Si aparece, se escapa o se pasa a un hash.
     *
     * ------------------------------------------------------------------------
     * ⚠ LA CLAVE NO LLEVA ORDINAL, Y NINGUNA COMBINACIÓN MÁS CORTA VALE
     * ------------------------------------------------------------------------
     * Un ROW_NUMBER() la habría hecho única por construcción, pero sólo aguanta
     * mientras la carga sea completa. Las seis columnas de negocio aguantan las
     * dos, así que si esto pasa algún día a incremental la clave sigue valiendo.
     *
     * Y hacen falta las seis. A este grano nada más corto es único:
     *
     *   emp_no + pay_date                    no basta
     *   + pay_type                           no basta
     *   + loan_number                        no basta
     *   + description                        separa los periodos
     *   + amount                             separa el adelanto del resto
     *
     * EL CASO QUE LO DEMUESTRA -- Jorge Zuzunaga, 2025-11-14. Una persona, UNA
     * FECHA DE PAGO, SEIS LÍNEAS: cuatro periodos de horas de agosto a octubre
     * recuperados de golpe (-420, -1.005, -1.327,50, -1.320) más un quinto
     * pagado (1.800) y recuperado en parte (-787,50) el mismo día. Cobra horas
     * cada quincena y al cerrar un préstamo se las descuentan.
     *
     * Lo mismo visto desde `comp.hours_logged`: 77 de sus 738 filas vienen de
     * DOS líneas de origen con el mismo emp_no, periodo y fecha de pago.
     *
     * ------------------------------------------------------------------------
     * ⚠ TRES COLUMNAS QUE LA VISTA TIENE QUE RESOLVER, NO EL JOB
     * ------------------------------------------------------------------------
     * 1. `hours_period_from` / `_to` NO EXISTEN en el origen: salen de
     *    `description` con "Hours entered from M.D.YY to M.D.YY". Tiene que ser
     *    LA MISMA extracción que usa `hours_logged_v`, no una nueva: dos
     *    implementaciones darían dos periodos distintos el día que aparezca una
     *    descripción rara, y las dos tablas dejarían de cuadrar sin que nada
     *    falle. Y pueden faltar sin que sea un error -- 4 de 731 allá.
     *
     * 2. `gl_code_credit` SE ESCRIBE EN `pay_category`, renombrada. El nombre
     *    del origen promete un código contable y lo que trae son categorías de
     *    pago: Non-Recoverable Hours 253, Recoverable Hours 251,
     *    Non-Recoverable Salary 190, Recoverable Salary 1, y nulo en Commission,
     *    Bonus y Override. NO sirve para cuadrar contra el P&L.
     *
     *    ⚠ Y SÓLO CUBRE 2026. Las 311 líneas de horas de 2025 vienen sin
     *    categoría porque Compensafe empezó a clasificar después. NO SE RELLENA
     *    EL HUECO: null ahí significa "no consta", y escribir 'Non-Recoverable'
     *    por defecto convertiría un no-consta en un no.
     *
     * 3. `description` VIAJA CON SU NOMBRE, Y ESO ES UNA DECISIÓN. El destino
     *    se llamó `check_description` durante unas horas y se renombró: ese
     *    nombre YA significa otra cosa en `finance_division.pl_transactions`
     *    --el memo de un apunte del libro mayor, que leen las reglas de centro
     *    de coste, los repartos y la detección del B2B success fee-- y dos
     *    campos de dos sistemas con el mismo nombre acaban en alguien
     *    aplicándole a uno una regla escrita para el otro.
     *
     *    ⚠ Y se quedó en `description`, el nombre del origen, en vez de un
     *    tercer nombre propio: el espejo y la fuente hablan el mismo idioma,
     *    que es lo que hace que este `select` no traduzca nada.
     *
     * ------------------------------------------------------------------------
     * ⚠ `unmatched_person` ES `not null`, Y SU NULO NO ES `false`
     * ------------------------------------------------------------------------
     * Si el mart no dice si casó o no, eso no es "casó bien". Es la columna que
     * da entrada a los 523.207,01 de nómina que el módulo no atribuye a nadie;
     * un `false` por defecto los haría desaparecer del recuento. Si llega nula,
     * la carga FALLA -- que es lo correcto: un hueco visible, no uno rellenado.
     *
     * ------------------------------------------------------------------------
     * LO QUE NO SE TRAE, Y POR QUÉ
     * ------------------------------------------------------------------------
     *   bps              Es amount/loan_amount*10.000 -- medido, 739 de 739 sin
     *                    una excepción. Derivable de las dos columnas que
     *                    viajan al lado, y la app ya calcula bps contra
     *                    `loan_officials`. Dos números guardados contestando lo
     *                    mismo se separan cuando uno de los denominadores
     *                    cambie.
     *   debit_credit     El signo, y `amount` ya lo lleva (Earnings Recapture
     *                    suma -203.614). ⚠ Si algún día `amount` llegara SIN
     *                    signo, esta columna tampoco se guarda: se aplica acá
     *                    antes de escribir, para que nadie pueda leer el
     *                    importe sin ella.
     *   borrower         Está en `comp.loan_commission`, por `loan_number`. Un
     *                    nombre de cliente en dos sitios son dos grafías.
     *   loan_branch_name El nombre del código que ya viaja. El catálogo es
     *                    `finance_division.branches`.
     *   property_state   Es un hecho del inmueble, no del pago.
     *   person_country   Ninguna pregunta de este módulo depende de él.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos: sube un archivo y las 1.859 dejan de ser 1.859.
     *
     *   COUNT(*) = COUNT(DISTINCT txn_key), sin nulos ni cadenas vacías. Si
     *     deja de valer, o apareció un `|` en una descripción o el COALESCE se
     *     cayó -- y el upsert empieza a pisar filas.
     *   `emp_no`, `pay_date`, `pay_type` y `amount` sin nulos.
     *   Que `hours_period_from` y `_to` falten NO es un defecto. Verificarlas
     *     como obligatorias es lo que rompió la carga de `hours_logged`.
     *   Que `pay_category` falte en 2025 TAMPOCO. Son 311 líneas y es la fuente
     *     la que no clasificaba entonces.
     *   Earnings Recapture tiene que sumar NEGATIVO.
     *
     * ⚠ Y UNA QUE NO ES UN INVARIANTE SINO UNA PREGUNTA ABIERTA, A CERRAR ANTES
     * DE QUE NINGUNA PANTALLA LEA LAS DOS TABLAS: `comp.hours_logged` tiene 738
     * filas construidas sobre 815 líneas de origen, e `is_hourly` marca acá 815
     * líneas. EL MISMO NÚMERO EXACTO, lo que apunta a que hours_logged ES este
     * subconjunto agrupado por periodo. Pero coincidir no es ser el mismo
     * conjunto: hay que cruzarlos y comprobarlo. Quien sume las dos cuenta las
     * horas dos veces, y son 1,24 millones.
     *
     * ⚠ SI ESTO PASA ALGÚN DÍA A INCREMENTAL: el borrado por rango va por
     * `pay_date` y NUNCA por `effective_date`. Una línea con fecha de cierre
     * vieja puede pagarse hoy -- Zuzunaga recuperó cuatro periodos de 2025 en un
     * solo día, y un borrado por fecha de cierre se habría llevado filas que el
     * archivo de esa quincena sí traía.
     */
    name: 'payroll_transaction',
    // ⚠ La vista, no la tabla: es la que calcula `txn_key`. Ver arriba.
    source: 'comp_marts.fct_payroll_transaction_v',
    target: 'payroll_transaction',
    schema: 'comp',
    conflict: 'txn_key',
    group: 'comp',
    // Las 24, no `*`: el origen trae además bps, debit_credit, borrower,
    // loan_branch_name, property_state y person_country, que no se espejan, y
    // con `*` el upsert fallaría contra una tabla que no las tiene.
    select: [
      // La clave, calculada en la vista. Ver la nota de arriba.
      'txn_key',
      'emp_no',
      // Nulo en ~22% de las líneas: hr_centralizado no las resuelve. Por eso la
      // identidad es emp_no y no esto.
      'person_code',
      'person_name',
      // El nombre como venía en el archivo, antes de resolver.
      'employee_in_file',
      // El veredicto del mart. NO es lo mismo que person_code IS NULL.
      'unmatched_person',
      // El roster manda cuando los dos hablan; esto sirve para quien el roster
      // no puede contestar.
      'hr_position',
      // La de la PERSONA.
      'branch_code',
      'loan_number',
      // La del PRÉSTAMO. No es la misma, y el P&L por Loan Officer depende de
      // esa diferencia: la escalera restringe el revenue a la sucursal propia.
      'loan_branch_code',
      'loan_amount',
      'pay_date',
      // La fecha de CIERRE: coincide con completed_date en 494 de 511 líneas de
      // comisión y es anterior a pay_date en 1.842 de 1.859, 16,6 días de
      // media. Es lo que permitiría comparar contra el P&L por el mismo
      // calendario -- pero eso es una decisión de la app, no de acá.
      'effective_date',
      // Extraídas de la descripción, arriba. Pueden faltar.
      'hours_period_from',
      'hours_period_to',
      'pay_type',
      // gl_code_credit renombrada. Ver la nota de arriba.
      'gl_code_credit AS pay_category',
      'adj_type',
      // No significan nada por separado: el lead source es derivado del par, y
      // "Base Plan" aparece cuatro veces por persona significando cosas
      // distintas. Viajan crudas; la interpretación vive en
      // mart_lead_source_check.
      'plan_name',
      'scenario',
      // ⚠ ESTA cuenta las horas, no pay_category: son 815 líneas contra 504.
      'is_hourly',
      'is_recapture',
      // Con su nombre de origen, a propósito. Ver la nota 3 de arriba.
      'description',
      // Con signo. Las recuperaciones son negativas y así se guardan.
      'amount',
    ].join(', '),
  },
  {
    /*
     * ========================================================================
     * REALTORS DEL PROGRAMA NPPM
     * ========================================================================
     *
     * Quién firmó contrato con Supreme para trabajar en la división, quién está
     * firmando, y quién lo reclutó. Al 2026-09-16 son 13, todas contratadas.
     *
     * ⚠ QUE EL CONTEO BAJE NO SIGNIFICA QUE ALGUIEN AVANZÓ. Eran 14 esa misma
     * mañana, con Albeiro Lopera en 'en proceso'. Se fue de la dimensión porque
     * su contratación quedó CANCELADA --en el tablero pasó a 'Completed New
     * Hire' con `is_cancelled`-- no porque haya entrado al roster. La lectura
     * cómoda es "se graduó a contratado", y era la equivocada.
     *
     * Para saber cuál de las dos pasó, mirar `org.hiring_tracking`: ahí la
     * persona sigue, con su sección y su `is_cancelled`. Esta tabla sólo dice
     * quién está hoy en el programa.
     * 13 columnas más `synced_at`, todas con el mismo nombre de los dos lados.
     *
     * ⚠ EL FILTRO YA VIENE APLICADO desde BigQuery: las filas que llegan ya son
     * del programa. `cargo` está para que se entienda POR QUÉ entró cada una, no
     * para volver a filtrar -- y hoy filtrar por él da mal, ver abajo.
     *
     * ------------------------------------------------------------------------
     * ⚠ `sf_nppm_flag` ES SÓLO CONTRASTE, NUNCA CRITERIO
     * ------------------------------------------------------------------------
     * Un `false` NO es un hueco de datos: hay 'Non-Producing Production
     * Manager' sin marcar en el CRM que son NPPM igual. El cargo ES la sigla
     * N-P-P-M, así que basta por sí solo, y Salesforce sólo decide en los de
     * Business Development. Usarlo como criterio los dejaría afuera sin que nada
     * falle.
     *
     * Al 2026-09-16 son cuatro: Eduardo Martinez Daboud, Marina Aguirre-Anthony,
     * Robert Kravitz y Valeria Gonzalez Uribe. Eran cinco el día anterior --Jose
     * Lopez Boggio salió del grupo cuando se arregló la resolución del código--
     * así que el número se mueve y lo que hay que recordar es la regla.
     *
     * ------------------------------------------------------------------------
     * ⚠ `recruited_by_bd` Y `contracted_date` VIENEN SÓLO DE SALESFORCE
     * ------------------------------------------------------------------------
     * Así que están vacías en los que no están marcados. Eso sí es un hueco real
     * del CRM, no del mapeo, y no hay que taparlo.
     *
     * ⚠ PERO LOS DOS HUECOS NO SON EL MISMO CONJUNTO. Hay quien tiene
     * `recruited_by_bd` y no tiene `contracted_date`: al 2026-09-16 es Nelson
     * Calderon, marcado en Salesforce y con reclutador ('Javier Peñaloza'). Su
     * fecha falta por otra razón, no por estar fuera del CRM.
     *
     * Escrito como comprobación, que es lo que no envejece: `sf_nppm_flag` y
     * `contracted_date IS NOT NULL` NO coinciden fila a fila. Quien explique los
     * huecos de fecha como "los que no están en Salesforce" deja ese caso sin
     * contar.
     *
     * ⚠ Y TENER `contracted_date` NO IMPLICA ESTAR CONTRATADO. Albeiro Lopera
     * tiene fecha (2026-08-26) con `estado = 'en proceso'` e `is_contracted`
     * falso. Quien use "tiene fecha" como atajo de "está contratado" lo cuenta
     * de más. Para eso está `is_contracted`, que es la columna que lo dice.
     *
     * ------------------------------------------------------------------------
     * QUÉ VERIFICAR DESPUÉS DE UNA CORRIDA
     * ------------------------------------------------------------------------
     * INVARIANTES, no conteos: el programa crece.
     *
     *   COUNT(*) = COUNT(DISTINCT realtor_code), sin nulos. Es la clave de
     *     conflicto y la PK del destino.
     *   `is_contracted` = (`estado` = 'contratado') en TODA fila. Son dos
     *     formas del mismo hecho y separarse sería un defecto de la vista.
     *   `display_name`, `is_active`, `is_contracted`, `sf_nppm_flag` y
     *     `sf_closed_won` sin nulos: el destino los tiene NOT NULL, así que un
     *     nulo hace fallar el upsert entero.
     *   El conteo de Supabase contra el de BigQuery, que `syncTable` ya compara.
     *
     * Al 2026-09-16: 14 filas, 13 con `estado = 'contratado'`, 12 con cargo de
     * NPPM y 2 de Business Development. Números del día, no criterio -- los
     * cuatro invariantes de arriba se comprobaron ese día y pasan.
     *
     * ⚠ ESOS 2 DE BUSINESS DEVELOPMENT VIENEN CON DOS GRAFÍAS DISTINTAS:
     * 'Business Development' (Albeiro Lopera) y 'BUSINESS DEVELOPMENT' (Fred
     * Gomez). Son la misma función escrita de dos maneras, así que `cargo`
     * tiene TRES valores distintos y no dos. Filtrar por igualdad exacta trae a
     * uno y pierde al otro -- y la regla de que el flag de Salesforce sólo
     * decide en Business Development hay que aplicarla sin distinguir
     * mayúsculas. Reportado; si se unifica arriba, esta nota se puede acortar.
     */
    name: 'nppm_realtor',
    source: 'lending_marts.dim_nppm_realtor_v2',
    target: 'nppm_realtor',
    schema: 'org',
    conflict: 'realtor_code',
    // Las 13 listadas, no `*`: ver la nota de `lo_recruitment`.
    select: [
      // La clave. Ver `lending_marts.nppm_realtor_code`, que la ancla.
      'realtor_code',
      'display_name',
      // El vínculo con el roster, cuando la persona está.
      'person_code',
      'branch_code',
      // ⚠ TRES valores, no dos: ver la nota de las dos grafías.
      'cargo',
      'estado',
      'is_contracted',
      'is_active',
      // Las dos de Salesforce: vacías en los cinco sin flag.
      'recruited_by_bd',
      'contracted_date',
      // Contraste, nunca criterio.
      'sf_nppm_flag',
      'sf_closed_won',
      'match_key',
    ].join(', '),
  },
];

/**
 * ============================================================================
 * LA PUERTA DE FRESCURA, UNA POR GRUPO
 * ============================================================================
 *
 * Era una sola y global, y eso dejó de servir cuando entró una segunda fuente
 * con su propio ritmo: Compensafe se carga por archivos --dos cargas en toda su
 * historia, el 27 de agosto y el 2 de septiembre-- mientras Salesforce llega a
 * diario. Con una puerta única, diez días sin subir un archivo de nómina
 * abortaban la corrida ENTERA y Salesforce dejaba de sincronizarse por una
 * fuente que no tiene nada que ver con él.
 *
 * Ahora cada grupo trae su sonda y su límite, y una vieja salta SOLO sus
 * tablas. El resto de la corrida sigue.
 *
 * MIN, no MAX, dentro de cada grupo, por lo de siempre: con MAX una tabla al
 * día taparía a otra tres días atrás y el job escribiría esas filas viejas
 * sobre buenas.
 */
type SyncGroup = 'core' | 'comp';

/**
 * ⚠ NO TODAS LAS FUENTES LLEVAN PUERTA, Y LA ASIMETRÍA ES DELIBERADA.
 *
 * Si estás leyendo esto porque `core` tiene límite y `comp` no, y parece un
 * olvido a medio terminar: no lo es, y añadirle uno a `comp` rompería el sync.
 * Son dos TIPOS de fuente distintos, y la puerta sólo significa algo en uno:
 *
 *   core   Salesforce -> BigQuery se sincroniza SOLO, cada noche. Que lleve 30
 *          horas sin moverse quiere decir que ese proceso automático está roto,
 *          y copiar datos viejos sobre buenos empeora las cosas. Ahí bloquear
 *          protege algo real.
 *
 *   comp   Compensafe se carga A MANO, subiendo archivos. Que lleve un mes sin
 *          archivo nuevo no es una avería: es que nadie subió uno. No hay nada
 *          roto de lo que un bloqueo pueda proteger, y bloquear sólo consigue
 *          dejar las tablas vacías o desactualizadas sin motivo.
 *          UN ESPEJO REFLEJA LO QUE HAY ARRIBA, aunque sea viejo.
 *
 * Lo que sí se conserva de la puerta es LA SEÑAL, que era lo valioso: `comp`
 * mide su edad igual y la publica en la respuesta --fecha de la última carga y
 * días transcurridos-- sin abortar y sin fallar la corrida. Así "Compensafe
 * lleva 40 días sin archivo nuevo" se ve cuando alguien mira, en vez de ser una
 * alarma que detiene el trabajo de las otras doce tablas.
 */
type FreshnessProbe =
  | {
      /** Por encima del límite, el grupo no se escribe. */
      mode: 'blocks';
      /** Devuelve una sola fila con `oldest_last_modified_time` en milisegundos. */
      query: string;
      /** Horas a partir de las cuales el grupo no se escribe. */
      maxAgeHours: number;
      /** Qué se está midiendo, para el mensaje. */
      probe: string;
    }
  | {
      /** Mide la edad y la publica. Nunca impide escribir. */
      mode: 'informs';
      query: string;
      probe: string;
    };

const FRESHNESS: Record<SyncGroup, FreshnessProbe> = {
  core: {
    mode: 'blocks',
    probe: "salesforce.__TABLES__ (Lead, Opportunity, Task, User)",
    maxAgeHours: 30,
    query: `
      SELECT MIN(last_modified_time) AS oldest_last_modified_time
      FROM salesforce.__TABLES__
      WHERE table_id IN ('Lead', 'Opportunity', 'Task', 'User')
    `,
  },
  comp: {
    /*
     * ⚠ SOLO LAS DOS TABLAS QUE ESTE JOB LEE, y no todo comp_marts.
     *
     * `branch_margin_stage` iba seis días por detrás de las demás el
     * 2026-09-12, y alimenta `branch_margin`, una vista que este job NO trae.
     * Un MIN sobre el dataset entero lo gobernaría esa tabla y bloquearía dos
     * sincronizaciones que están al día por una tercera que no nos importa.
     *
     * `payroll_transaction_stage` está porque `hours_logged` sale de
     * `fct_payroll_transaction`, que sale de ahí: la vista no expone un
     * `uploaded_at` propio que consultar.
     *
     * ⚠ Y DESDE EL 2026-09-16 ESA MISMA TABLA ALIMENTA ADEMÁS UNA QUE ESTE JOB
     * LEE DIRECTO: `payroll_transaction`. La sonda no cambia --ya la medía-- y
     * queda dicho para que nadie la retire pensando que sólo cubre una fuente
     * indirecta. Hoy cubre las dos.
     *
     * ⚠ Y ES `uploaded_at` DE LAS TABLAS DE LANDING, NO `__TABLES__`. Esta
     * fuente no viene de Salesforce sino de archivos que alguien sube, así que
     * lo que hay que medir es cuándo se subió el último archivo y no cuándo se
     * tocó la tabla por última vez.
     */
    probe: 'comp_marts.payroll_by_loan_stage y payroll_transaction_stage (uploaded_at)',
    /*
     * SÓLO INFORMA. No hay límite porque no habría nada que un límite
     * protegiera: la fuente se carga a mano, así que un archivo viejo no es una
     * avería sino la ausencia de un archivo nuevo. Ver la nota del tipo.
     *
     * Llegó a tener uno de 14 días y se quitó. Era además un número que no se
     * podía derivar de nada: el histórico COMPLETO de cargas son dos --
     * 2026-08-27 con 28 filas, que parece una prueba, y 2026-09-02 con 361. Dos
     * puntos no son una cadencia, así que el umbral habría bloqueado según una
     * frecuencia inventada.
     */
    mode: 'informs',
    query: `
      SELECT MIN(t) AS oldest_last_modified_time FROM (
        SELECT UNIX_MILLIS(MAX(uploaded_at)) AS t
        FROM \`comp_marts.payroll_by_loan_stage\`
        UNION ALL
        SELECT UNIX_MILLIS(MAX(uploaded_at)) AS t
        FROM \`comp_marts.payroll_transaction_stage\`
      )
    `,
  },
};

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
  /**
   * Por qué no se tocó esta tabla, cuando la puerta de su grupo cerró.
   *
   * Presente en vez de ausente: una tabla omitida que no aparece en la
   * respuesta se lee igual que una que se escribió sin problemas.
   */
  omitida_por?: string;
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
 * Edad de la carga MÁS VIEJA del grupo, en horas.
 *
 * Lanza si la sonda no devuelve nada. Qué se hace con eso depende del modo: una
 * puerta sin respuesta no escribe, una sonda informativa se limita a decir que
 * no pudo medir. Lo decide `evaluateGates`, no esta función.
 */
async function getDataAgeHours(
  bq: ReturnType<typeof getBigQueryClient>,
  group: SyncGroup,
): Promise<{ ageHours: number; lastModified: string }> {
  const gate = FRESHNESS[group];
  const [rows] = await bq.query({ query: gate.query });
  const raw = rows?.[0]?.oldest_last_modified_time;
  const ms = raw === null || raw === undefined ? NaN : Number(raw);

  if (!Number.isFinite(ms)) {
    throw new Error(`${gate.probe} no devolvió una marca de tiempo utilizable`);
  }

  return {
    ageHours: (Date.now() - ms) / 3_600_000,
    lastModified: new Date(ms).toISOString(),
  };
}

/**
 * Lo que la sonda de un grupo midió, y si dejó escribir.
 *
 * Unión y no un objeto con todo opcional: un grupo bloqueado SIEMPRE tiene
 * motivo y uno que escribe nunca lo tiene, y escrito así el compilador lo sabe.
 * Con `motivo: string | null` había que rellenar un caso imposible con un texto
 * que nadie iba a leer nunca.
 *
 * `puede_escribir: false` sólo puede salir de una sonda `blocks`. Una `informs`
 * mide y publica, pase lo que pase -- incluso si la propia sonda falla.
 */
type GateResult =
  | {
      grupo: SyncGroup;
      sonda: string;
      /** 'blocks' puede impedir la escritura; 'informs' nunca. */
      modo: 'blocks' | 'informs';
      puede_escribir: true;
      /** Null sólo cuando la sonda falló y el grupo escribe igual. */
      edad_horas: number | null;
      dias_desde_la_carga: number | null;
      /** Null cuando no hay límite: la sonda sólo informa. */
      limite_horas: number | null;
      last_modified: string | null;
      motivo: null;
      /** Qué pasó con la sonda, cuando no pudo medir pero no bloquea. */
      aviso?: string;
    }
  | {
      grupo: SyncGroup;
      sonda: string;
      modo: 'blocks';
      /** Ninguna tabla del grupo se escribe. */
      puede_escribir: false;
      /** Null cuando la sonda misma falló: no hubo edad que medir. */
      edad_horas: number | null;
      dias_desde_la_carga: number | null;
      limite_horas: number;
      last_modified: string | null;
      motivo: string;
    };

/**
 * Mide la frescura de cada grupo ANTES de escribir nada.
 *
 * Una puerta cerrada salta las tablas de SU grupo y ninguna más. Era una sola y
 * global, y con eso Compensafe --que lleva diez días sin archivo nuevo por la
 * razón más simple, que nadie subió uno-- habría abortado también las once
 * tablas de Salesforce, que están al día.
 *
 * Hoy sólo `core` puede cerrar. `comp` mide y publica. Ver la nota de
 * FreshnessProbe sobre por qué la asimetría es correcta.
 */
async function evaluateGates(
  bq: ReturnType<typeof getBigQueryClient>,
  groups: SyncGroup[],
): Promise<Map<SyncGroup, GateResult>> {
  const out = new Map<SyncGroup, GateResult>();
  for (const group of groups) {
    const gate = FRESHNESS[group];
    const dias = (h: number) => Number((h / 24).toFixed(1));
    try {
      const { ageHours, lastModified } = await getDataAgeHours(bq, group);
      const medido = {
        grupo: group,
        sonda: gate.probe,
        edad_horas: Number(ageHours.toFixed(2)),
        dias_desde_la_carga: dias(ageHours),
        last_modified: lastModified,
      };

      if (gate.mode === 'informs') {
        // Se publica y se escribe. Un dato viejo aquí es una observación sobre
        // quién sube archivos, no un defecto que haya que contener.
        console.log(
          `[sync] grupo ${group}: última carga ${lastModified} (${dias(ageHours)} días). Se copia igual.`,
        );
        out.set(group, {
          ...medido,
          modo: 'informs',
          puede_escribir: true,
          limite_horas: null,
          motivo: null,
        });
        continue;
      }

      const fresco = ageHours <= gate.maxAgeHours;
      if (!fresco) {
        console.warn(
          `[sync] grupo ${group}: datos de ${ageHours.toFixed(1)}h, sobre el límite de ${gate.maxAgeHours}h`,
        );
      }
      out.set(
        group,
        fresco
          ? { ...medido, modo: 'blocks', puede_escribir: true, limite_horas: gate.maxAgeHours, motivo: null }
          : {
              ...medido,
              modo: 'blocks',
              puede_escribir: false,
              limite_horas: gate.maxAgeHours,
              motivo: `los datos tienen ${ageHours.toFixed(1)}h, sobre el límite de ${gate.maxAgeHours}h. No se escribió nada de este grupo.`,
            },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (gate.mode === 'informs') {
        /*
         * La sonda falló y el grupo escribe igual. No es una contradicción: esta
         * sonda no decide nada, sólo cuenta desde cuándo no llega un archivo.
         * Perder esa cuenta no es razón para dejar de copiar -- se dice en
         * `aviso` y se sigue.
         */
        console.warn(`[sync] grupo ${group}: la sonda informativa falló (${message}). Se copia igual.`);
        out.set(group, {
          grupo: group,
          sonda: gate.probe,
          modo: 'informs',
          puede_escribir: true,
          edad_horas: null,
          dias_desde_la_carga: null,
          limite_horas: null,
          last_modified: null,
          motivo: null,
          aviso: `no se pudo medir la edad del dato: ${message}`,
        });
        continue;
      }
      // Una puerta que no puede responder es una pregunta sin respuesta, y sin
      // respuesta no se escribe: ese grupo queda fuera, la corrida sigue.
      console.error(`[sync] grupo ${group}: la puerta de frescura falló: ${message}`);
      out.set(group, {
        grupo: group,
        sonda: gate.probe,
        modo: 'blocks',
        puede_escribir: false,
        edad_horas: null,
        dias_desde_la_carga: null,
        limite_horas: gate.maxAgeHours,
        last_modified: null,
        motivo: `la puerta de frescura falló: ${message}`,
      });
    }
  }
  return out;
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

  /*
   * Qué grupos corre esta llamada. Sin `?group=`, todos.
   *
   * EL CRON NO LO USA y es a propósito: sigue siendo `/api/sync` a las 08:00,
   * una pasada con los catorce destinos. El aislamiento entre fuentes ya lo dan
   * las puertas por grupo, así que partir el cron habría cambiado algo que
   * funciona a cambio de nada.
   *
   * Está para reintentar a mano: cuando Compensafe se quede fuera por un
   * archivo viejo y haya que reintentar sólo eso sin volver a tocar las once
   * tablas de Salesforce que ya escribieron bien.
   *
   * Un valor desconocido es un 400 y no una corrida vacía: una llamada mal
   * escrita que sincroniza cero tablas y responde 200 es el fallo que no se ve
   * hasta que alguien nota que los datos llevan semanas quietos.
   */
  const pedido = new URL(req.url).searchParams.get('group');
  const todos: SyncGroup[] = ['core', 'comp'];
  if (pedido !== null && !todos.includes(pedido as SyncGroup)) {
    return Response.json(
      {
        ok: false,
        error: `grupo desconocido: "${pedido}". Los que hay: ${todos.join(', ')}.`,
      },
      { status: 400 },
    );
  }
  const grupos: SyncGroup[] = pedido === null ? todos : [pedido as SyncGroup];
  const aCorrer = SYNCS.filter((s) => grupos.includes(groupOf(s)));

  // --- Frescura, medida por grupo. Nada se escribe antes de esto. ---
  // Sólo `core` puede impedir la escritura; `comp` mide y deja pasar.
  const puertas = await evaluateGates(bq, grupos);

  // One timestamp for the whole run, taken before the first write. Every row
  // written this run carries it, and the sweep deletes anything older, so the
  // two halves cannot disagree about what "this run" means.
  const syncedAt = new Date().toISOString();

  // --- Write. One table failing must not stop the others. ---
  const resultados: TableResult[] = [];
  const omitidas: TableResult[] = [];
  for (const spec of aCorrer) {
    /*
     * La puerta del grupo cerró. La tabla se omite y se DICE, con el motivo:
     * una tabla que no se escribió y no aparece en la respuesta se lee como una
     * tabla que se escribió bien.
     */
    const puerta = puertas.get(groupOf(spec))!;
    if (!puerta.puede_escribir) {
      console.warn(`[sync] ${spec.name}: omitida, ${puerta.motivo}`);
      omitidas.push({
        tabla: qualified(spec),
        filas_bigquery: 0,
        filas_supabase: null,
        filas_borradas: null,
        // No es un desajuste: es una tabla que no se tocó a propósito.
        coincide: true,
        duracion_ms: 0,
        error: null,
        omitida_por: puerta.motivo,
      });
      continue;
    }
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
  // El pipeline es del grupo `core`: sale de Salesforce como las otras once.
  const pipelineStarted = Date.now();
  if (!grupos.includes('core')) {
    console.log('[sync] pipeline: fuera de los grupos pedidos, no se corre');
  } else if (!puertas.get('core')!.puede_escribir) {
    const motivo = (puertas.get('core') as Extract<GateResult, { puede_escribir: false }>).motivo;
    console.warn(`[sync] pipeline: omitido, ${motivo}`);
    omitidas.push({
      tabla: `${PIPELINE_SCHEMA}.pipeline_snapshots (+loans, +resolved)`,
      filas_bigquery: 0,
      filas_supabase: null,
      filas_borradas: null,
      coincide: true,
      duracion_ms: 0,
      error: null,
      omitida_por: motivo,
    });
  } else try {
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

  /*
   * With the sweep in place the target is a mirror of the source, so a count
   * mismatch is a real defect rather than expected drift, and fails the run.
   *
   * ⚠ UNA PUERTA CERRADA TAMBIÉN FALLA LA CORRIDA, aunque no haya escrito nada
   * mal. No escribir porque el dato está viejo es el comportamiento correcto, y
   * aun así es un estado que alguien tiene que mirar: con un 200 nadie se
   * entera de que Salesforce lleva dos días sin sincronizarse. El código dice
   * que hay algo que atender; `omitidas` dice exactamente qué y por qué.
   *
   * Hoy sólo `core` puede llenar `omitidas`. Un Compensafe viejo NO falla la
   * corrida: se copia igual y su edad viaja en `puertas`, para que se vea sin
   * que nada se detenga. Esa es toda la diferencia entre una fuente automática
   * que puede averiarse y una manual que simplemente espera a que alguien suba
   * un archivo.
   */
  const ok =
    fallidas.length === 0 && desajustadas.length === 0 && omitidas.length === 0;

  return Response.json(
    {
      ok,
      duracion_total_ms: Date.now() - started,
      synced_at: syncedAt,
      grupos_pedidos: grupos,
      // Una entrada por grupo: qué se midió, cuándo fue la última carga y si
      // dejó escribir. Es lo que explica una corrida sin escrituras.
      puertas: [...puertas.values()],
      tablas_ok: resultados.length - fallidas.length,
      tablas_fallidas: fallidas.map((r) => r.tabla),
      tablas_con_desajuste: desajustadas.map((r) => r.tabla),
      tablas_omitidas: omitidas.map((r) => r.tabla),
      resultados: [...resultados, ...omitidas],
    },
    { status: ok ? 200 : 500 },
  );
}
