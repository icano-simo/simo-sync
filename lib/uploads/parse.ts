/**
 * Lectura de los archivos subidos: .xlsx (ExcelJS) y .csv (Papa Parse).
 *
 * Todo se lee como TEXTO. La tabla destino es de staging, y el casteo se hace
 * después en las vistas de `lending_marts`: adivinar tipos acá haría que una
 * celda rara ('N/A' en una columna de fechas) tirara la carga entera, cuando el
 * trabajo de esta app es dejar el archivo disponible tal como vino.
 */
import ExcelJS from 'exceljs';
import { applyExcelTablePatch } from './excelTablePatch';
import Papa from 'papaparse';
import { normalizeHeaders } from './sources';

/*
 * Antes de leer nada: ExcelJS 4.4.0 no puede abrir el archivo de RRHH por un
 * defecto en su lectura de tablas. Ver `excelTablePatch.ts`.
 */
applyExcelTablePatch();

/** Opciones de parseo que salen de la configuración de la fuente. */
export type ParseOptions = {
  /**
   * Fila del encabezado, 1-based. Por defecto la 1.
   *
   * El roster de USA trae el encabezado en la 2: la fila 1 dice "Search:". Con
   * la 1 el parser tomaría esa celda como el único encabezado y produciría una
   * tabla de una sola columna, sin fallar.
   */
  headerRow?: number;
  /** Ver `SourceRules.requireNonEmpty`. */
  requireNonEmpty?: string;
};

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

/**
 * Pasa el valor de una celda a texto sin inventar formatos.
 *
 * Exportada para `scripts/dump-values.ts`, que necesita la conversión EXACTA
 * que se manda a BigQuery: una copia parecida en el script haría que la
 * inspección mostrara algo distinto de lo que se carga, que es justo el error
 * que el script existe para evitar.
 */
export function cellToText(value: unknown): string | null {
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
  options: ParseOptions = {},
): Promise<ParsedFile> {
  const { headerRow = 1, requireNonEmpty } = options;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];

  if (!sheet) {
    /*
     * Los nombres van ENTRE COMILLAS, y no es cosmético: ' Forecast' y
     * 'Forecast' se leen idénticos en un log sin ellas. El 31 de agosto eso
     * costó tres intentos fallidos seguidos antes de que alguien notara que la
     * pestaña traía un espacio adelante -- el mensaje decía la verdad y era
     * ilegible igual.
     */
    const available = workbook.worksheets.map((w) => `"${w.name}"`).join(', ');
    throw new Error(`sheet "${sheetName}" not found in workbook; available: ${available}`);
  }

  const rawHeaders: string[] = [];
  sheet.getRow(headerRow).eachCell({ includeEmpty: true }, (cell) => {
    rawHeaders.push((cellToText(cell.value) ?? '').trim());
  });

  // Encabezados vacíos a la derecha: columnas que no existen.
  while (rawHeaders.length && rawHeaders[rawHeaders.length - 1] === '') rawHeaders.pop();

  if (rawHeaders.length === 0) {
    throw new Error(`sheet "${sheet.name}" has no header on row ${headerRow}`);
  }

  const matrix: (string | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // Se saltea el encabezado Y todo lo que esté por encima: con header_row=2,
    // la fila 1 ('Search:') no es un dato.
    if (rowNumber <= headerRow) return;
    const values: (string | null)[] = [];
    for (let i = 1; i <= rawHeaders.length; i++) {
      values.push(cellToText(row.getCell(i).value));
    }
    matrix.push(values);
  });

  return buildRows(rawHeaders, matrix, requireNonEmpty);
}

/** Lee un .csv. Papa Parse maneja comillas y saltos de línea dentro de campo. */
export function parseCsv(text: string, options: ParseOptions = {}): ParsedFile {
  const { headerRow = 1, requireNonEmpty } = options;

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
  });

  const data = result.data.filter((r) => Array.isArray(r));
  if (data.length === 0) throw new Error('csv is empty');

  /*
   * `skipEmptyLines: 'greedy'` ya sacó las líneas en blanco, así que el índice
   * de acá cuenta filas con contenido y no líneas del archivo. Para un
   * header_row > 1 sobre un CSV con líneas vacías arriba, las dos numeraciones
   * dejan de coincidir. Hoy ninguna fuente CSV usa header_row > 1; cuando
   * aparezca una, se lee sin 'greedy' y se filtra después.
   */
  const headerIndex = headerRow - 1;
  if (data.length <= headerIndex) {
    throw new Error(`csv has no header on row ${headerRow}`);
  }

  const rawHeaders = (data[headerIndex] as string[]).map((h) => (h ?? '').trim());
  while (rawHeaders.length && rawHeaders[rawHeaders.length - 1] === '') rawHeaders.pop();

  if (rawHeaders.length === 0) throw new Error(`csv has no header on row ${headerRow}`);

  const matrix = data.slice(headerIndex + 1).map((values) => {
    const out: (string | null)[] = [];
    for (let i = 0; i < rawHeaders.length; i++) {
      const v = (values as string[])[i];
      out.push(v === undefined || v === '' ? null : v);
    }
    return out;
  });

  return buildRows(rawHeaders, matrix, requireNonEmpty);
}

/** Resultado de descartar columnas: qué se fue y qué se pidió descartar y no estaba. */
export type DropResult = {
  parsed: ParsedFile;
  /** Nombres normalizados efectivamente quitados. */
  dropped: string[];
  /** Nombres de `drop_columns` que no existen en el archivo. */
  notFound: string[];
};

/**
 * Quita columnas del archivo ya parseado, ANTES de escribir a BigQuery.
 *
 * Es lo que mantiene los campos sensibles del roster de Colombia (cédula,
 * cuenta bancaria, dirección, contactos de emergencia, seguridad social) fuera
 * de BigQuery: no viajan en el NDJSON y tampoco aparecen en el esquema, así que
 * no existen en la tabla ni como columna vacía.
 *
 * OJO CON EL NAMESPACE -- `drop_columns` usa los nombres YA NORMALIZADOS
 * ('numero_de_cedula'), mientras que `required_columns` usa los nombres CRUDOS
 * tal como vienen en el archivo ('Número de Cédula'). Son dos listas en la
 * misma tabla que se comparan contra cosas distintas, a propósito: descartar
 * apunta a la columna que se va a crear en BigQuery, validar apunta al archivo
 * que llegó.
 *
 * Se descarta DESPUÉS de validar para que la validación vea el archivo completo:
 * el conteo de columnas esperado y las obligatorias hablan del archivo de
 * origen, no de lo que termina cargándose.
 */
export function dropColumns(parsed: ParsedFile, drop: string[]): DropResult {
  if (drop.length === 0) return { parsed, dropped: [], notFound: [] };

  const wanted = new Set(drop.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const keepIndexes: number[] = [];
  const dropped: string[] = [];

  parsed.headers.forEach((header, i) => {
    if (wanted.has(header.toLowerCase())) dropped.push(header);
    else keepIndexes.push(i);
  });

  const droppedLower = new Set(dropped.map((d) => d.toLowerCase()));
  const notFound = [...wanted].filter((w) => !droppedLower.has(w));

  const headers = keepIndexes.map((i) => parsed.headers[i]);
  const rawHeaders = keepIndexes.map((i) => parsed.rawHeaders[i]);

  // Se reconstruye cada fila con las claves que quedan en vez de borrar las
  // otras: `delete` sobre el objeto original dejaría la fila con la forma vieja
  // si alguien conserva una referencia previa.
  const rows = parsed.rows.map((row) => {
    const out: Record<string, string | null> = {};
    for (const header of headers) out[header] = row[header] ?? null;
    return out;
  });

  return {
    parsed: { rawHeaders, headers, rows, discardedRows: parsed.discardedRows },
    dropped,
    notFound,
  };
}
