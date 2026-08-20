/**
 * Imprime los encabezados de un archivo de fuente, crudos y normalizados.
 *
 * Es para preparar las vistas de `lending_marts`: los nombres normalizados son
 * exactamente los que la carga va a crear en BigQuery, porque este script
 * importa la MISMA `normalizeHeaders` que usa la ruta de carga.
 *
 *   node scripts/dump-headers.ts <archivo.xlsx> [nombre-de-hoja]
 *
 * Requiere Node 22.6+ (ejecuta .ts directamente, sin compilar).
 */
import ExcelJS from 'exceljs';
import { normalizeHeaders } from '../lib/uploads/sources.ts';

const [filePath, sheetName = 'Data'] = process.argv.slice(2);

if (!filePath) {
  console.error('uso: node scripts/dump-headers.ts <archivo.xlsx> [nombre-de-hoja]');
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(filePath);

console.log(`hojas en el archivo: ${wb.worksheets.map((w) => `'${w.name}'`).join(', ')}`);

const sheet = wb.getWorksheet(sheetName);
if (!sheet) {
  console.error(`no existe la hoja '${sheetName}'`);
  process.exit(1);
}

// Mismo criterio que parseXlsx: encabezado en la fila 1, se recortan los
// vacíos de la derecha.
const raw: string[] = [];
sheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
  const v = cell.value;
  raw.push(String(v ?? '').trim());
});
while (raw.length && raw[raw.length - 1] === '') raw.pop();

const normalized = normalizeHeaders(raw);

console.log(`\nhoja '${sheet.name}': ${raw.length} columnas\n`);
console.log('  #  | crudo'.padEnd(50) + '| normalizado');
console.log('-'.repeat(90));
raw.forEach((r, i) => {
  const n = String(i + 1).padStart(3);
  console.log(`  ${n}  | ${r.padEnd(44)}| ${normalized[i]}`);
});

// Dos encabezados distintos que colapsan al mismo nombre reciben sufijo (_2,
// _3). Si aparece alguno, la vista tiene que usar el nombre con sufijo.
const bases = new Map<string, string[]>();
raw.forEach((r, i) => {
  const base = normalized[i].replace(/_\d+$/, '');
  bases.set(base, [...(bases.get(base) ?? []), r]);
});
const collisions = [...bases.entries()].filter(([, rs]) => rs.length > 1);
if (collisions.length) {
  console.log('\nOJO -- encabezados que colapsan al mismo nombre base:');
  for (const [base, rs] of collisions) {
    console.log(`  ${base}: ${rs.map((x) => `'${x}'`).join(', ')}`);
  }
}

console.log('\n--- lista plana, para pegar en la vista ---');
console.log(normalized.join('\n'));
