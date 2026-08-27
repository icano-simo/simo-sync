/**
 * Muestra, celda por celda, QUÉ VALOR va a quedar en el NDJSON que se carga a
 * BigQuery, junto con la evidencia de por qué: el tipo de la celda y su formato
 * de número.
 *
 * Existe para una pregunta concreta: si una columna está formateada como % en
 * Excel, el valor guardado es la fracción (0.0625) y no lo que se ve en
 * pantalla (6.25%). Una vista que hoy asume 6.25 devuelve números 100x
 * distintos sin lanzar ningún error, así que hay que confirmarlo ANTES de
 * cargar, no después.
 *
 *   node scripts/dump-values.ts <archivo.xlsx> [hoja] [filas] [col1,col2,...]
 *
 * Los nombres de columna se buscan por su encabezado CRUDO, sin distinguir
 * mayúsculas. Sin lista, muestra las columnas con formato de número no trivial,
 * que son las candidatas a este problema.
 *
 * Requiere Node 22.6+ (ejecuta .ts directamente, sin compilar).
 */
import { register } from 'node:module';
import ExcelJS from 'exceljs';

// `lib/uploads/parse.ts` importa './sources' sin extensión, que node no
// resuelve solo. El hook lo arregla, y por eso el import es dinámico: uno
// estático se resolvería antes de que el hook quede registrado.
register('./ts-resolve-hook.mjs', import.meta.url);
const { cellToText } = await import('../lib/uploads/parse.ts');
const { normalizeHeaders } = await import('../lib/uploads/sources.ts');

const [filePath, sheetName = 'Data', rowsArg = '3', colsArg] = process.argv.slice(2);

if (!filePath) {
  console.error('uso: node scripts/dump-values.ts <archivo.xlsx> [hoja] [filas] [col1,col2,...]');
  process.exit(1);
}

const maxRows = Number(rowsArg);
const wanted = colsArg
  ? colsArg.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
  : null;

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(filePath);

const sheet = wb.getWorksheet(sheetName);
if (!sheet) {
  console.error(
    `no existe la hoja '${sheetName}'; hay: ${wb.worksheets.map((w) => `'${w.name}'`).join(', ')}`,
  );
  process.exit(1);
}

const rawHeaders: string[] = [];
sheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
  rawHeaders.push(String(cell.value ?? '').trim());
});
while (rawHeaders.length && rawHeaders[rawHeaders.length - 1] === '') rawHeaders.pop();

const normalized = normalizeHeaders(rawHeaders);

/** Índices (base 1, como los usa ExcelJS) de las columnas a mostrar. */
const columns = rawHeaders
  .map((raw, i) => ({ raw, name: normalized[i], index: i + 1 }))
  .filter((c) => (wanted ? wanted.includes(c.raw.toLowerCase()) : true));

if (wanted) {
  const found = new Set(columns.map((c) => c.raw.toLowerCase()));
  const missing = wanted.filter((w) => !found.has(w));
  if (missing.length) console.log(`OJO -- no están en la hoja: ${missing.join(', ')}\n`);
}

// Filas de datos: se saltea el encabezado y se toman las primeras `maxRows` que
// tengan algo, para no mostrar las filas vacías del final de la conversión.
const dataRows: number[] = [];
sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
  if (rowNumber === 1 || dataRows.length >= maxRows) return;
  const hasSomething = columns.some((c) => cellToText(row.getCell(c.index).value) !== null);
  if (hasSomething) dataRows.push(rowNumber);
});

for (const col of columns) {
  const cells = dataRows.map((rowNumber) => {
    const cell = sheet.getRow(rowNumber).getCell(col.index);
    return {
      rowNumber,
      // 'type' es el enum de ExcelJS: 2=Number, 3=String, 4=Date, 6=Formula.
      type: cell.type,
      numFmt: cell.numFmt ?? '(sin formato)',
      ndjson: cellToText(cell.value),
    };
  });

  // Sin lista explícita se muestran sólo las columnas con formato de número:
  // una columna de texto plano no puede tener el problema del %.
  if (!wanted && cells.every((c) => c.numFmt === '(sin formato)')) continue;

  console.log(`\n${col.raw}`);
  console.log(`  -> columna en BigQuery: ${col.name}`);
  for (const c of cells) {
    const value = c.ndjson === null ? 'null' : JSON.stringify(c.ndjson);
    console.log(
      `  fila ${String(c.rowNumber).padStart(4)} | numFmt ${c.numFmt.padEnd(18)} | tipo ${c.type} | NDJSON ${value}`,
    );
  }

  const isPercent = cells.some((c) => c.numFmt.includes('%'));
  if (isPercent) {
    console.log(
      '  VEREDICTO: formato de %. El valor guardado es la FRACCIÓN, no lo que se ve\n' +
        '             en pantalla. Si la vista de hoy espera 6.25, necesita * 100.',
    );
  } else if (cells.some((c) => c.type === 2)) {
    console.log('  VEREDICTO: numérica sin formato de %. El valor llega tal cual.');
  } else {
    console.log('  VEREDICTO: no es numérica; el texto llega literal, sin reescalar.');
  }
}
