import { randomUUID } from 'node:crypto';
import type { ParsedFile } from './parse';

/**
 * ============================================================================
 * COLUMNAS QUE ESCRIBE EL CARGADOR, NO EL ARCHIVO
 * ============================================================================
 *
 * Para las fuentes que ACUMULAN (`load_mode = 'append'`), donde cada carga es un
 * período y la tabla guarda todos. Sin estas tres columnas no hay forma de
 * saber qué filas entraron juntas ni en qué orden venían.
 *
 * Son genéricas a propósito: cualquier fuente que acumule las necesita, no sólo
 * la que motivó agregarlas.
 *
 * SÓLO SE AGREGAN EN 'append'. En 'replace' la tabla entera es una sola carga,
 * así que el lote es la tabla y el orden no sobrevive de todos modos. Agregarlas
 * también ahí cambiaría el esquema de `encompass_loans_stage` en el próximo
 * WRITE_TRUNCATE, y eso es un cambio a una tabla en producción que no
 * corresponde hacer como efecto secundario de dar de alta otra fuente.
 */

/** Nombres de las columnas. Constantes porque las consumen las vistas. */
export const UPLOAD_BATCH_ID = 'upload_batch_id';
export const UPLOADED_AT = 'uploaded_at';
export const ROW_INDEX = 'row_index';

/**
 * Reservados: un archivo que traiga una columna que normalice a uno de estos
 * chocaría con la que escribe el cargador -- misma clave en el JSON y campo
 * duplicado en el esquema. Gana uno de los dos en silencio.
 */
export const RESERVED_COLUMNS: readonly string[] = [UPLOAD_BATCH_ID, UPLOADED_AT, ROW_INDEX];

/**
 * Campos tipados de las tres columnas.
 *
 * Las del ARCHIVO van todas como STRING porque no sabemos qué trae cada celda y
 * adivinar tipos es lo que rompe las vistas. Estas tres son distintas: las
 * genera el cargador, así que su tipo lo decidimos nosotros y no cambia nunca.
 * Tiparlas acá evita que cada vista tenga que castear un timestamp desde texto.
 */
export const METADATA_FIELDS = [
  { name: UPLOAD_BATCH_ID, type: 'STRING' },
  { name: UPLOADED_AT, type: 'TIMESTAMP' },
  { name: ROW_INDEX, type: 'INT64' },
] as const;

/** Una fila lista para el NDJSON: el archivo es texto, la metadata no. */
export type LoadRow = Record<string, string | number | null>;

export type BatchStamp = {
  uploadBatchId: string;
  /** ISO 8601 en UTC, que es lo que BigQuery acepta para TIMESTAMP en JSON. */
  uploadedAt: string;
};

/** Un lote nuevo. El uuid no significa nada por sí solo: agrupa. */
export function newBatchStamp(): BatchStamp {
  return { uploadBatchId: randomUUID(), uploadedAt: new Date().toISOString() };
}

/**
 * Columnas del archivo que chocarían con las del cargador.
 *
 * Se compara contra el nombre YA NORMALIZADO, que es el que termina siendo
 * campo en BigQuery.
 */
export function reservedCollisions(headers: string[]): string[] {
  return headers.filter((h) => RESERVED_COLUMNS.includes(h));
}

/**
 * Agrega la metadata a cada fila.
 *
 * `row_index` empieza en 1 y cuenta las filas TAL COMO SE CARGAN, después del
 * encabezado y después de descartar las filas vacías. No es un identificador:
 * se recalcula en cada carga y sólo significa algo junto con `upload_batch_id`.
 *
 * Existe porque una tabla de BigQuery no tiene orden propio, y hay fuentes donde
 * el orden ES el dato: si un valor aparece una sola vez al empezar un bloque y
 * hay que arrastrarlo hacia abajo, sin una columna de orden las filas siguientes
 * se atribuyen a lo que el motor devuelva primero. Eso no falla, da otro
 * resultado -- que es peor.
 */
export function withBatchMetadata(parsed: ParsedFile, stamp: BatchStamp): {
  headers: string[];
  rows: LoadRow[];
} {
  const headers = [...parsed.headers, ...RESERVED_COLUMNS];

  const rows: LoadRow[] = parsed.rows.map((row, i) => ({
    ...row,
    [UPLOAD_BATCH_ID]: stamp.uploadBatchId,
    [UPLOADED_AT]: stamp.uploadedAt,
    [ROW_INDEX]: i + 1,
  }));

  return { headers, rows };
}
