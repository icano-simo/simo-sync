import 'server-only';
import { normalizeRow, type getBigQueryClient } from '@/lib/bigquery';
import { getSupabaseClient } from '@/lib/supabase-admin';

/**
 * ============================================================================
 * PIPELINE: lending_marts.pipeline_snapshot -> pipeline_forecast.*
 * ============================================================================
 *
 * El pipeline es una FOTO DIARIA. Salesforce sólo guarda el estado actual y su
 * transfer a BigQuery corre una vez al día, pero el equipo refresca el reporte
 * dos o tres veces por jornada -- de ahí que el archivo se siga subiendo a mano.
 *
 * NO USA `syncTable`, y no es un detalle de implementación: aquello es una
 * tabla espejo de una vista, con upsert por clave y barrido. Esto es otra cosa:
 * una fuente que escribe TRES tablas emparentadas, se reemplaza por día y no
 * tiene clave estable por fila (`source_loan_id` se repite entre días, que es
 * justamente el punto de una serie de fotos).
 *
 * REEMPLAZO POR DÍA. Si ya hay un snapshot de ese día se borra y se escribe el
 * nuevo; gana el último. El borrado se lleva sus hijos por las FKs, que están
 * en CASCADE -- verificado en `pg_constraint`, no asumido.
 *
 * LOS DÍAS ANTERIORES NO SE TOCAN. El borrado va acotado por `snapshot_date` al
 * día que trae el lote, y hay un tope de seguridad: si ese día tuviera más
 * snapshots de los que puede tener, se aborta antes de borrar nada. Los 22
 * históricos no se pueden regenerar desde ningún lado.
 *
 * UN SOLO SNAPSHOT ACTIVO, y lo impone la base: el índice único parcial
 * `uniq_pipeline_snapshot_active` permite una única fila con `is_active`. Por eso
 * el snapshot se inserta APAGADO y se prende al final, después de sus hijos --
 * ver el paso 3. Insertarlo ya activo funciona sólo cuando el borrado del día
 * liberó el índice, que es por qué este job corrió tres días antes de fallar en
 * el primer día nuevo.
 */

const BATCH_SIZE = 500;

/** Schema destino. Requiere sus propios grants para service_role. */
export const PIPELINE_SCHEMA = 'pipeline_forecast';

/**
 * Tope de seguridad del borrado. Hoy hay exactamente un snapshot por día -- el
 * parser del navegador ya reemplazaba el del día. Si aparecieran más, algo
 * cambió y conviene que alguien mire antes de que un borrado se lleve de más.
 */
const MAX_SNAPSHOTS_PER_DAY = 2;

/**
 * Un solo día: el más reciente que exista en la vista.
 *
 * La vista ya resuelve "gana la última carga" por día (su CTE `live`), así que
 * acá no hay que desempatar nada: para un `snapshot_date` dado devuelve un solo
 * `upload_batch_id`.
 *
 * DOS COLUMNAS QUE NO EXISTEN EN LA VISTA y hay que derivar de
 * `opportunity_name`, que llega como 'ANGEL ONTIVEROS - 710002056041':
 *   source_loan_id  el número del final -- 12 dígitos, único en el día
 *   borrower_name   lo que queda al sacarle ese sufijo
 * Verificado sobre las 907 filas del día: ninguna sin número al final, 907
 * números distintos, todos de 12 dígitos. Mapear `opportunity_name` directo a
 * `source_loan_id` habría metido el nombre del deudor en la clave de cada fila.
 *
 * `close_month` es DATE en la vista y TEXT 'YYYY-MM' en Supabase.
 * `affinity_program` es BOOLEAN en la vista y TEXT en Supabase, donde el parser
 * guardaba la celda cruda: '' o 'true'. Se reproduce esa convención.
 */
function buildQuery(): string {
  return `
    WITH ultimo AS (
      SELECT MAX(snapshot_date) AS d
      FROM \`lending_marts.pipeline_snapshot\`
    )
    SELECT
      v.snapshot_date,
      v.upload_batch_id,
      v.uploaded_at,
      REGEXP_EXTRACT(v.opportunity_name, r'([0-9]{6,})\\s*$')                  AS source_loan_id,
      TRIM(REGEXP_REPLACE(v.opportunity_name, r'\\s*-\\s*[0-9]{6,}\\s*$', '')) AS borrower_name,
      v.is_pipeline,
      v.loan_folder,
      v.branch,
      v.branch_raw,
      v.channel,
      v.milestone,
      v.milestone_raw,
      v.healthy,
      v.healthiness_raw,
      FORMAT_DATE('%Y-%m', v.close_month)      AS close_month,
      v.est_closing_date,
      v.milestone_date,
      v.disbursement_date,
      v.amount,
      v.loan_officer,
      v.loan_status,
      v.loan_type,
      v.loan_program,
      v.property_state,
      v.branch_transferred,
      v.production_support_notes,
      v.strategy_raw,
      v.opportunity_owner,
      v.opportunity_owner_title,
      v.nppm_realtor,
      v.referred_by,
      IF(v.affinity_program, 'true', '')       AS affinity_program
    FROM \`lending_marts.pipeline_snapshot\` v, ultimo
    WHERE v.snapshot_date = ultimo.d
  `;
}

type ViewRow = Record<string, unknown>;

export type PipelineSyncResult = {
  snapshot_date: string | null;
  snapshot_id: number | null;
  filas_origen: number;
  pipeline: number;
  resueltos: number;
  funded: number;
  adverse: number;
  snapshots_reemplazados: number;
  /** Conteos releídos del servidor, no lo que creímos escribir. */
  verificado: { loans: number | null; resolved: number | null; activos: number | null } | null;
  coincide: boolean;
  omitido: string | null;
};

/**
 * Carpetas que cuentan como cerrado. Todo lo demás que no esté en pipeline es
 * adverso -- la regla es por descarte a propósito: una carpeta nueva en el
 * export cae en 'adverse' y se ve, en vez de desaparecer del reparto.
 */
const FUNDED_FOLDERS = new Set(['Funded', 'Brokered']);

export async function syncPipelineSnapshot(
  bq: ReturnType<typeof getBigQueryClient>,
): Promise<PipelineSyncResult> {
  const vacio: PipelineSyncResult = {
    snapshot_date: null,
    snapshot_id: null,
    filas_origen: 0,
    pipeline: 0,
    resueltos: 0,
    funded: 0,
    adverse: 0,
    snapshots_reemplazados: 0,
    verificado: null,
    coincide: false,
    omitido: null,
  };

  const [rawRows] = await bq.query({ query: buildQuery() });
  const rows: ViewRow[] = rawRows.map((r: Record<string, unknown>) => normalizeRow(r));

  /*
   * Una fuente que devuelve cero filas es una falla de la fuente, no un día sin
   * pipeline. Seguir borraría el snapshot del día y lo reemplazaría por nada.
   */
  if (rows.length === 0) {
    return { ...vacio, omitido: 'la vista no devolvió filas; no se tocó nada' };
  }

  const snapshotDate = String(rows[0].snapshot_date);
  const uploadBatchId = String(rows[0].upload_batch_id);
  const uploadedAt = String(rows[0].uploaded_at);

  const pipelineRows = rows.filter((r) => r.is_pipeline === true);
  const resolvedRows = rows.filter((r) => r.is_pipeline !== true);

  const sb = getSupabaseClient(PIPELINE_SCHEMA);

  // ---- 1. Qué hay de ese día -------------------------------------------
  const { data: existentes, error: selectError } = await sb
    .from('pipeline_snapshots')
    .select('id')
    .eq('snapshot_date', snapshotDate);

  if (selectError) {
    throw new Error(`reading snapshots for ${snapshotDate} failed: ${selectError.message}`);
  }

  const aBorrar = (existentes ?? []).map((r) => (r as { id: number }).id);

  if (aBorrar.length > MAX_SNAPSHOTS_PER_DAY) {
    throw new Error(
      `refusing to delete ${aBorrar.length} snapshots for ${snapshotDate}; ` +
        `expected at most ${MAX_SNAPSHOTS_PER_DAY}`,
    );
  }

  // ---- 2. Borrar el del día. La cascada se lleva loans y resolved -------
  if (aBorrar.length) {
    const { error: deleteError } = await sb
      .from('pipeline_snapshots')
      .delete()
      .in('id', aBorrar);

    if (deleteError) {
      throw new Error(`deleting snapshots ${aBorrar.join(', ')} failed: ${deleteError.message}`);
    }
  }

  // ---- 3. La cabecera --------------------------------------------------
  /*
   * `file_name` y `data_as_of` los derivaba el parser del NOMBRE DEL ARCHIVO
   * ('report1787955663425.xls' -> el epoch en milisegundos). La vista no lo
   * conoce: el nombre se queda en la app de cargas y no viaja al stage.
   *
   * Se sintetiza a partir del lote, y `data_as_of_source` lo dice para que la
   * diferencia sea visible en los datos en vez de quedar disimulada como si
   * fuera lo mismo. `data_as_of` pasa a ser CUÁNDO SE SUBIÓ y no cuándo
   * Salesforce generó el export: para el caso normal -- se sube el archivo del
   * día -- coinciden dentro del mismo día; para un export viejo subido después,
   * no. Si eso importa, hay que llevar el nombre del archivo hasta el stage.
   */
  /*
   * ⚠ SE INSERTA is_active: false, Y SE ACTIVA AL FINAL. El orden no es
   * cosmético.
   *
   * Hay un índice único parcial que permite UNA sola fila activa en toda la
   * tabla:
   *
   *   CREATE UNIQUE INDEX uniq_pipeline_snapshot_active
   *     ON pipeline_forecast.pipeline_snapshots (is_active) WHERE is_active
   *
   * Insertar el nuevo ya activo choca con el anterior, que todavía lo está.
   * Este job vivió tres días sin que se notara porque el snapshot del día ya
   * existía y se reemplazaba: borrarlo liberaba el índice justo antes del
   * insert. El primer DÍA NUEVO --el 31, con el del 28 todavía activo-- falló.
   *
   * Se activa DESPUÉS de escribir los hijos, no antes: así la app nunca ve un
   * snapshot vigente con cero préstamos adentro.
   *
   * Si algo se cae en el medio, queda un instante --o un rato, si falla-- sin
   * ningún snapshot activo. Es el lado seguro en el que fallar: sin activo la
   * app no muestra datos y se nota; con dos activos mostraría cualquiera de los
   * dos sin avisar. El índice, además, es lo que hizo que este bug apareciera
   * como un error en vez de como dos snapshots vigentes en silencio.
   */
  const { data: inserted, error: insertError } = await sb
    .from('pipeline_snapshots')
    .insert({
      file_name: `bigquery:${uploadBatchId}`,
      row_count: rows.length,
      snapshot_date: snapshotDate,
      data_as_of: uploadedAt,
      data_as_of_source: 'bigquery_batch',
      is_active: false,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new Error(`inserting the snapshot for ${snapshotDate} failed: ${insertError?.message}`);
  }

  const snapshotId = (inserted as { id: number }).id;

  // ---- 4. Los hijos ----------------------------------------------------
  const loans = pipelineRows.map((r) => ({
    snapshot_id: snapshotId,
    source_loan_id: r.source_loan_id,
    branch: r.branch,
    raw_org_id: r.branch_raw,
    channel: r.channel,
    milestone: r.milestone,
    raw_milestone: r.milestone_raw,
    healthy: r.healthy,
    raw_healthiness: r.healthiness_raw,
    close_month: r.close_month,
    est_closing_date: r.est_closing_date,
    amount: r.amount,
    loan_officer: r.loan_officer,
    borrower_name: r.borrower_name,
    milestone_date: r.milestone_date,
    branch_transferred: r.branch_transferred,
    loan_status: r.loan_status,
    disbursement_date: r.disbursement_date,
    production_support_note_history: r.production_support_notes,
    loan_type: r.loan_type,
    loan_program: r.loan_program,
    strategy_raw: r.strategy_raw,
    opportunity_owner_title: r.opportunity_owner_title,
    nppm_realtor: r.nppm_realtor,
    referred_by: r.referred_by,
    affinity_program: r.affinity_program,
    opportunity_owner: r.opportunity_owner,
    property_state: r.property_state,
  }));

  const resolved = resolvedRows.map((r) => ({
    snapshot_id: snapshotId,
    source_loan_id: r.source_loan_id,
    branch: r.branch,
    channel: r.channel,
    status: FUNDED_FOLDERS.has(String(r.loan_folder)) ? 'funded' : 'adverse',
    borrower_name: r.borrower_name,
    loan_officer: r.loan_officer,
    loan_status: r.loan_status,
    disbursement_date: r.disbursement_date,
    est_closing_date: r.est_closing_date,
    amount: r.amount,
    raw_loan_folder: r.loan_folder,
    production_support_note_history: r.production_support_notes,
    loan_type: r.loan_type,
    loan_program: r.loan_program,
    strategy_raw: r.strategy_raw,
    opportunity_owner_title: r.opportunity_owner_title,
    nppm_realtor: r.nppm_realtor,
    referred_by: r.referred_by,
    affinity_program: r.affinity_program,
    opportunity_owner: r.opportunity_owner,
    branch_transferred: r.branch_transferred,
    property_state: r.property_state,
  }));

  await insertInBatches(sb, 'pipeline_loans', loans);
  await insertInBatches(sb, 'pipeline_resolved_loans', resolved);

  // ---- 5. Un solo snapshot activo, en dos pasos y en este orden ---------
  /*
   * APAGAR PRIMERO, PRENDER DESPUÉS. Al revés habría dos activos por un instante
   * y el índice único parcial rechazaría el segundo -- que es exactamente el bug
   * que este orden arregla.
   *
   * Son dos statements y no uno porque PostgREST no expone transacciones: cada
   * llamada es su propio commit. Entre las dos la tabla queda sin ningún
   * snapshot activo. Es a propósito: el hueco es de milisegundos y sin activo la
   * app no muestra datos --se nota--, mientras que con dos mostraría uno de los
   * dos al azar. Si hiciera falta que sea atómico, hay que envolverlo en una
   * función de Postgres y llamarla por RPC.
   *
   * El primer UPDATE toca filas de OTROS DÍAS: es el único de este job que lo
   * hace, y toca un booleano de control, nunca un dato. El parser del navegador
   * hacía lo mismo.
   */
  const { error: deactivateError } = await sb
    .from('pipeline_snapshots')
    .update({ is_active: false })
    .eq('is_active', true)
    .neq('id', snapshotId);

  if (deactivateError) {
    throw new Error(`clearing is_active failed: ${deactivateError.message}`);
  }

  const { error: activateError } = await sb
    .from('pipeline_snapshots')
    .update({ is_active: true })
    .eq('id', snapshotId);

  if (activateError) {
    /*
     * Los datos están escritos y no hay ningún snapshot activo. Se dice así,
     * completo: el mensaje tiene que distinguir "no se cargó nada" de "se cargó
     * todo pero nadie lo ve", porque la segunda se arregla con un UPDATE de una
     * línea y la primera no.
     */
    throw new Error(
      `snapshot ${snapshotId} for ${snapshotDate} was written with its loans but could ` +
        `not be activated (${activateError.message}); no snapshot is active right now`,
    );
  }

  // ---- 6. Verificar releyendo ------------------------------------------
  const loansCount = await countFor(sb, 'pipeline_loans', snapshotId);
  const resolvedCount = await countFor(sb, 'pipeline_resolved_loans', snapshotId);

  /*
   * Cuántos snapshots quedaron activos. El índice garantiza que no haya DOS,
   * así que lo que esto detecta es el CERO: los dos updates de arriba son dos
   * commits, y si el segundo no llegó a aplicarse los datos quedan cargados y
   * invisibles. Sin esta lectura, la corrida se reportaría como correcta.
   */
  const { count: activos, error: activeError } = await sb
    .from('pipeline_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  if (activeError) {
    throw new Error(`counting active snapshots failed: ${activeError.message}`);
  }

  const funded = resolved.filter((r) => r.status === 'funded').length;

  return {
    snapshot_date: snapshotDate,
    snapshot_id: snapshotId,
    filas_origen: rows.length,
    pipeline: loans.length,
    resueltos: resolved.length,
    funded,
    adverse: resolved.length - funded,
    snapshots_reemplazados: aBorrar.length,
    verificado: { loans: loansCount, resolved: resolvedCount, activos: activos ?? null },
    coincide:
      loansCount === loans.length && resolvedCount === resolved.length && activos === 1,
    omitido: null,
  };
}

type Client = ReturnType<typeof getSupabaseClient>;

async function insertInBatches(sb: Client, table: string, rows: unknown[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + BATCH_SIZE));
    if (error) {
      throw new Error(`insert into ${table} failed at row ${i}: ${error.message}`);
    }
  }
}

async function countFor(sb: Client, table: string, snapshotId: number): Promise<number | null> {
  const { count, error } = await sb
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('snapshot_id', snapshotId);

  if (error) throw new Error(`count on ${table} failed: ${error.message}`);
  return count ?? null;
}
