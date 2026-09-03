/**
 * ¿Sigue haciendo falta el parche de `lib/uploads/excelTablePatch.ts`?
 *
 *   node scripts/check-xlsx-tables.ts
 *
 * Fabrica un .xlsx con la forma EXACTA de la hoja 'Active' del roster de
 * Colombia -- 38 columnas, 3 <filterColumn>, y seis <tableColumn> con
 * <calculatedColumnFormula> adentro, el primero en la posición 1 -- y comprueba
 * tres cosas:
 *
 *   1. que SIN el parche, ExcelJS falla con el error de producción;
 *   2. que CON el parche, `parseXlsx` devuelve las 38 columnas de datos;
 *   3. que la tabla misma queda con sus 38 columnas parseadas, sin truncar.
 *
 * La 3 importa porque es la diferencia entre las dos partes del parche: el
 * arreglo de `parseClose` hace que se parseen las 38, y por eso la red del
 * autoFilter --que recortaría a 1-- nunca llega a dispararse.
 *
 * Si algún día ExcelJS publica el arreglo, el paso 1 deja de fallar y este
 * script lo dice: ahí el parche se puede borrar. Mientras el paso 1 siga
 * fallando, el parche es lo único que permite leer el roster de Colombia.
 *
 * Requiere Node 22.6+ (ejecuta .ts directamente, sin compilar).
 */
import { register } from 'node:module';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

register('./ts-resolve-hook.mjs', import.meta.url);

/**
 * Las 38 columnas de 'Active', con los nombres reales en las posiciones que
 * importan y relleno en el resto.
 */
const COLUMNS = Array.from({ length: 38 }, (_, i) => `col_${i + 1}`);
COLUMNS[0] = '#';
COLUMNS[1] = 'NOMBRE';
COLUMNS[2] = 'ID';
COLUMNS[12] = 'antiquity';
COLUMNS[27] = 'Day';
COLUMNS[28] = 'Month2';
COLUMNS[29] = 'Year';
COLUMNS[30] = 'Year2';

/**
 * Posiciones 1-based de las columnas CALCULADAS, que son las que traen hijos.
 * La primera está en la 1: ahí es donde ExcelJS corta y se queda con una sola
 * columna de las 38.
 */
const CALCULATED = new Set([1, 13, 28, 29, 30, 31]);

/** Letra de columna de Excel, 1-based: 1 -> A, 38 -> AL. */
function columnLetter(n: number): string {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

const LAST = columnLetter(COLUMNS.length);

/** Un libro con la forma del roster: encabezado en la fila 2. */
async function buildWorkbookWithBadTable({ calculated }: { calculated: boolean }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Active');
  ws.addRow(['Centralizacion SLTEAM']).commit();
  ws.addRow(COLUMNS).commit();
  ws.addRow(COLUMNS.map((_, i) => `a${i + 1}`)).commit();
  ws.addRow(COLUMNS.map((_, i) => `b${i + 1}`)).commit();

  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());

  /*
   * La tabla como la escribió Excel. Los conteos del XML COINCIDEN --38
   * columnas declaradas, 38 <tableColumn>-- y aun así rompe: lo que no coincide
   * es lo que ExcelJS alcanza a PARSEAR. Con un hijo en la columna 1, la lista
   * se corta ahí y quedan 1 columna contra 3 <filterColumn>.
   */
  const tableColumns = COLUMNS.map((name, i) =>
    calculated && CALCULATED.has(i + 1)
      ? `<tableColumn id="${i + 1}" name="${name}"><calculatedColumnFormula>SUM(1)</calculatedColumnFormula></tableColumn>`
      : `<tableColumn id="${i + 1}" name="${name}"/>`,
  ).join('');

  // Sólo tres columnas del autoFilter, como el archivo real.
  const filterColumns = [0, 12, 27].map((colId) => `<filterColumn colId="${colId}"/>`).join('');

  zip.file(
    'xl/tables/table1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Tabla1" displayName="Tabla1" ref="A2:${LAST}4" totalsRowShown="0">
  <autoFilter ref="A2:${LAST}4">${filterColumns}</autoFilter>
  <tableColumns count="${COLUMNS.length}">${tableColumns}</tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`,
  );

  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheetXml = (await zip.file(sheetPath)!.async('string')).replace(
    '</worksheet>',
    '<tableParts count="1"><tablePart r:id="rIdTable1"/></tableParts></worksheet>',
  );
  zip.file(sheetPath, sheetXml);

  const relsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
  const relsFile = zip.file(relsPath);
  const relsXml = relsFile
    ? await relsFile.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file(
    relsPath,
    relsXml.replace(
      '</Relationships>',
      '<Relationship Id="rIdTable1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
    ),
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

const file = await buildWorkbookWithBadTable({ calculated: true });
console.log(
  `archivo fabricado: ${file.length} bytes — ${COLUMNS.length} columnas, ` +
    `3 filterColumn, columnas calculadas en ${[...CALCULATED].join(', ')}\n`,
);

// ---- 1. Sin el parche ------------------------------------------------------
let sigueFallando = false;
try {
  await new ExcelJS.Workbook().xlsx.load(file as unknown as ArrayBuffer);
  console.log('1. ExcelJS SIN parche: leyó el archivo.');
  console.log('   => el defecto está arreglado. `lib/uploads/excelTablePatch.ts` ya no hace falta.');
} catch (err) {
  sigueFallando = true;
  console.log(`1. ExcelJS SIN parche: falla — ${err instanceof Error ? err.message : String(err)}`);
  console.log('   => el defecto sigue ahí. El parche hace falta.');
}

// ---- 2. Con el parche, por el camino real de la app ------------------------
const { parseXlsx } = await import('../lib/uploads/parse.ts');
const parsed = await parseXlsx(file as unknown as ArrayBuffer, 'Active', { headerRow: 2 });

console.log(`\n2. parseXlsx CON parche: ${parsed.rows.length} filas, ${parsed.headers.length} columnas`);
console.log(`   primeras: ${parsed.headers.slice(0, 3).join(', ')}`);
console.log(`   últimas:  ${parsed.headers.slice(-3).join(', ')}`);

const primera = parsed.headers[0];
const ultima = parsed.headers[parsed.headers.length - 1];
const celdasCompletas =
  parsed.rows.length === 2 &&
  parsed.headers.length === COLUMNS.length &&
  parsed.rows[0][primera] === 'a1' &&
  parsed.rows[0][ultima] === `a${COLUMNS.length}` &&
  parsed.rows[1][ultima] === `b${COLUMNS.length}`;

// ---- 3. La tabla misma, sin truncar ----------------------------------------
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(file as unknown as ArrayBuffer);
const tablas = wb.getWorksheet('Active')!.tables as Record<string, { table?: { columns?: unknown[] } }>;
const parseadas = tablas[Object.keys(tablas)[0]]?.table?.columns?.length ?? 0;

console.log(`\n3. columnas de la tabla parseadas: ${parseadas} (el XML declara ${COLUMNS.length})`);
console.log(
  parseadas === COLUMNS.length
    ? '   => no se truncó: el arreglo de parseClose alcanza, la red del autoFilter no se usa.'
    : '   => se truncó. La lectura funciona por el recorte del autoFilter, no por el arreglo.',
);

const ok = celdasCompletas && parseadas === COLUMNS.length;
console.log(`\n${ok ? 'OK' : 'FALLA'}: el archivo que rompe a ExcelJS se lee entero, con sus ${COLUMNS.length} columnas.`);
if (!sigueFallando) {
  console.log('Nota: el paso 1 ya no falla, así que conviene revisar si el parche puede irse.');
}
process.exit(ok ? 0 : 1);
