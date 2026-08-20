/**
 * Lectura de los archivos subidos: .xlsx (ExcelJS) y .csv (Papa Parse).
 *
 * Todo se lee como TEXTO. La tabla destino es de staging, y el casteo se hace
 * después en las vistas de `lending_marts`: adivinar tipos acá haría que una
 * celda rara ('N/A' en una columna de fechas) tirara la carga entera, cuando el
 * trabajo de esta app es dejar el archivo disponible tal como vino.
 */
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { normalizeHeaders } from './sources';

export type ParsedFile = {
  /** Encabezados crudos, tal como venían en el archivo. */
  rawHeaders: string[];
  /** Encabezados normalizados a nombres válidos de BigQuery, mismo orden. */
  headers: string[];
  /** Filas ya normalizadas, con las claves de `headers`. */
  rows: Record<string, string | null>[];
  /** Filas descartadas por no tener la columna obligatoria. */
  discardedRows: number;
};

/** Pasa el valor de una celda a texto sin inventar formatos. */
function cellToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    // ISO, no el formato local: estable entre entornos.
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Celdas con fórmula: interesa el resultado, no la fórmula.
    if ('result' in obj) return cellToText(obj.result);
    // Texto enriquecido: se concatenan los fragmentos.
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('text' in obj) return cellToText(obj.text);
    if ('hyperlink' in obj) return cellToText(obj.text ?? obj.hyperlink);
    return JSON.stringify(value);
  }

  const text = String(value);
  return text;
}

/**
 * Arma las filas a partir de encabezados y una matriz de valores, descartando
 * las que no tengan la columna obligatoria.
 */
function buildRows(
  rawHeaders: string[],
  matrix: (string | null)[][],
  requireNonEmpty?: string,
): ParsedFile {
  const headers = normalizeHeaders(rawHeaders);

  // El índice se busca por el nombre CRUDO, que es como lo declara la fuente.
  const guardIndex = requireNonEmpty
    ? rawHeaders.findIndex((h) => h.trim().toLowerCase() === requireNonEmpty.trim().toLowerCase())
    : -1;

  const rows: Record<string, string | null>[] = [];
  let discardedRows = 0;

  for (const values of matrix) {
    if (guardIndex >= 0) {
      const guard = values[guardIndex];
      if (guard === null || guard === undefined || String(guard).trim() === '') {
        discardedRows++;
        continue;
      }
    }

    // Una fila enteramente vacía tampoco es un dato.
    if (values.every((v) => v === null || v === undefined || String(v).trim() === '')) {
      discardedRows++;
      continue;
    }

    const row: Record<string, string | null> = {};
    headers.forEach((header, i) => {
      const v = values[i];
      row[header] = v === undefined || v === null || v === '' ? null : String(v);
    });
    rows.push(row);
  }

  return { rawHeaders, headers, rows, discardedRows };
}

/**
 * Lee un .xlsx.
 *
 * Se lee el .xlsx directamente y no una conversión a CSV porque los comentarios
 * de Encompass traen saltos de línea dentro de la celda: al convertir, esos
 * saltos rompen las filas y el archivo queda corrido.
 *
 * `sheetName` viene de `uploads.source`. El export de Encompass trae dos hojas
 * idénticas, 'Table' y 'Data'; la configuración apunta a 'Data'.
 */
export async function parseXlsx(
  buffer: ArrayBuffer,
  sheetName: string | null,
  requireNonEmpty?: string,
): Promise<ParsedFile> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];

  if (!sheet) {
    const available = workbook.worksheets.map((w) => w.name).join(', ');
    throw new Error(`sheet "${sheetName}" not found in workbook; available: ${available}`);
  }

  // Encabezado en la primera fila.
  const headerRow = sheet.getRow(1);
  const rawHeaders: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    rawHeaders.push((cellToText(cell.value) ?? '').trim());
  });

  // Encabezados vacíos a la derecha: columnas que no existen.
  while (rawHeaders.length && rawHeaders[rawHeaders.length - 1] === '') rawHeaders.pop();

  if (rawHeaders.length === 0) {
    throw new Error(`sheet "${sheet.name}" has no header row`);
  }

  const matrix: (string | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // el encabezado
    const values: (string | null)[] = [];
    for (let i = 1; i <= rawHeaders.length; i++) {
      values.push(cellToText(row.getCell(i).value));
    }
    matrix.push(values);
  });

  return buildRows(rawHeaders, matrix, requireNonEmpty);
}

/** Lee un .csv. Papa Parse maneja comillas y saltos de línea dentro de campo. */
export function parseCsv(text: string, requireNonEmpty?: string): ParsedFile {
  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
  });

  const data = result.data.filter((r) => Array.isArray(r));
  if (data.length === 0) throw new Error('csv is empty');

  const rawHeaders = (data[0] as string[]).map((h) => (h ?? '').trim());
  while (rawHeaders.length && rawHeaders[rawHeaders.length - 1] === '') rawHeaders.pop();

  if (rawHeaders.length === 0) throw new Error('csv has no header row');

  const matrix = data.slice(1).map((values) => {
    const out: (string | null)[] = [];
    for (let i = 0; i < rawHeaders.length; i++) {
      const v = (values as string[])[i];
      out.push(v === undefined || v === '' ? null : v);
    }
    return out;
  });

  return buildRows(rawHeaders, matrix, requireNonEmpty);
}
