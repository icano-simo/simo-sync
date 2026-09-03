import TableColumnXform from 'exceljs/lib/xlsx/xform/table/table-column-xform.js';
import TableXform from 'exceljs/lib/xlsx/xform/table/table-xform.js';

/**
 * ============================================================================
 * PARCHE: ExcelJS pierde columnas de tabla y revienta al abrir el libro
 * ============================================================================
 *
 * `Centralizacion_Información_SLTEAM.xlsx` trae tres tablas de Excel y ExcelJS
 * 4.4.0 falla al abrirlo, ANTES de mirar una sola celda:
 *
 *   Cannot set properties of undefined (setting 'filterButton')
 *
 * ---------------------------------------------------------------------------
 * LA CAUSA: UN <tableColumn> CON HIJOS TRUNCA LA LISTA DE COLUMNAS
 * ---------------------------------------------------------------------------
 * `TableColumnXform.parseClose()` devuelve `false` SIEMPRE, sin mirar qué tag
 * se está cerrando. Y `ListXform.parseClose` interpreta ese `false` como "el
 * hijo terminó": empuja el modelo y suelta el parser.
 *
 * Con una columna que tiene hijos --`calculatedColumnFormula`, `extLst`,
 * `xmlColumnPr`, cosas que Excel escribe solo-- pasa esto:
 *
 *   <tableColumn id="3" name="C">     abre: la lista toma el parser
 *     <calculatedColumnFormula/>      se ignora
 *   </calculatedColumnFormula>        parseClose -> false: EMPUJA Y SUELTA
 *   </tableColumn>                    la lista ya no tiene parser -> false
 *                                     -> table-xform da la LISTA por cerrada
 *
 * Las columnas que venían después se pierden. Después, el bucle de
 * `table-xform.js:101` recorre las columnas del `<autoFilter>` y escribe en las
 * de la tabla POR ÍNDICE; con menos columnas de las que el archivo declara, el
 * índice se sale y se intenta escribir `filterButton` sobre `undefined`.
 *
 * Por eso los conteos del XML pueden coincidir --38 y 38-- y el archivo romper
 * igual: lo que no coincide no es lo que declara el archivo, sino lo que ExcelJS
 * alcanza a parsear.
 *
 * ---------------------------------------------------------------------------
 * LO QUE TRAE EL ARCHIVO REAL, VERIFICADO
 * ---------------------------------------------------------------------------
 *   Table1 (hoja 'Active')  38 columnas · 3 filterColumn · CORTA EN LA 1 -> rompe
 *   Table2                  29 columnas · 29 filterColumn · sin hijos -> no corta
 *   Table5                  15 columnas · 0 filterColumn · el bucle no corre
 *
 * Seis columnas de Table1 tienen hijos --'#', 'antiquity', 'Day', 'Month2',
 * 'Year', 'Year2'-- porque son columnas CALCULADAS y Excel les escribe un
 * `<calculatedColumnFormula>`. La primera está en la posición 1, así que ExcelJS
 * se queda con UNA columna de 38 y tres `filterColumn` alcanzan para desbordar.
 *
 * Es Table1 la que rompe, no la de 29 contra 29: lo que decide no es cuántas
 * columnas declara la tabla, sino dónde está la primera columna calculada.
 *
 * ---------------------------------------------------------------------------
 * QUÉ HACE
 * ---------------------------------------------------------------------------
 * 1. `parseClose` sólo termina la columna cuando cierra `</tableColumn>`. Los
 *    hijos se siguen ignorando --no los necesitamos-- pero ya no cortan la
 *    lista. Es el arreglo de la causa, y con él las 38 columnas se parsean.
 *
 * 2. Una red por si el mismo choque llega por otro camino: si el bucle fuera a
 *    salirse igual, se recortan las columnas del autoFilter y SE AVISA por
 *    consola. Recortar en silencio escondería una desincronización nueva; con
 *    el aviso, la carga funciona y queda el rastro para investigar.
 *
 * Con el archivo de RRHH la red NO se dispara: el paso 3 del script de
 * comprobación verifica que la tabla queda con sus 38 columnas. Si algún día
 * aparece ese aviso en los logs, es un caso nuevo, no éste.
 *
 * Ninguna de las dos toca una celda. `filterButton` sólo importa para volver a
 * ESCRIBIR la tabla, cosa que esta app no hace nunca: sólo lee.
 *
 * ---------------------------------------------------------------------------
 * LO QUE SE DESCARTÓ, Y POR QUÉ
 * ---------------------------------------------------------------------------
 *   actualizar ExcelJS   4.4.0 es la última publicada. No hay arreglo upstream.
 *   lector en streaming  no toca estos xform, pero falló al abrir el libro por
 *                        otro lado.
 *   quitar las tablas    hay que sacar `xl/tables/*`, sus relaciones Y el
 *   del zip              `<tableParts>` de cada hoja, los tres consistentes.
 *                        Tres formas nuevas de equivocarse sobre un archivo que
 *                        además trae tablas dinámicas, comentarios y VML.
 *
 * SE APLICA UNA VEZ, al importar `lib/uploads/parse.ts`, así que lo tiene
 * cualquier lectura de cualquier fuente.
 *
 * CÓMO SABER SI SIGUE HACIENDO FALTA: `node scripts/check-xlsx-tables.ts`
 * fabrica el archivo que fallaba y comprueba las dos cosas. Si ExcelJS publica
 * el arreglo, ese script lo dice y este archivo se puede borrar.
 */

type TableColumnState = { model?: unknown };
type TableColumnParseClose = (this: TableColumnState, name: string) => boolean;

type TableState = {
  map?: {
    autoFilter?: { model?: { columns?: unknown[] } };
    tableColumns?: { model?: unknown[] };
  };
};
type TableParseClose = (this: TableState, name: string) => boolean;

let applied = false;

export function applyExcelTablePatch(): void {
  if (applied) return;
  applied = true;

  patchTableColumn();
  patchTableOverflowNet();
}

/** El arreglo de la causa: la columna termina en `</tableColumn>` y no antes. */
function patchTableColumn(): void {
  const xform = TableColumnXform as unknown as {
    prototype: { parseClose: TableColumnParseClose; tag: string };
  };
  const original = xform.prototype?.parseClose;

  /*
   * Si el interno cambió de forma no se parchea nada, y se avisa. Un parche
   * aplicado a ciegas sobre algo que ya no existe rompería la lectura de las
   * once fuentes, no sólo la que necesitaba el arreglo.
   */
  if (typeof original !== 'function') {
    console.warn(
      '[uploads] ExcelJS TableColumnXform.parseClose no tiene la forma esperada; ' +
        'el parche de tablas no se aplicó. Revisar si sigue haciendo falta.',
    );
    return;
  }

  const patched: TableColumnParseClose = function patchedParseClose(name) {
    // true = "sigo abierta". Sólo el cierre propio termina la columna.
    return name !== 'tableColumn';
  };

  xform.prototype.parseClose = patched;
}

/** La red: si el índice fuera a salirse igual, recortar Y avisar. */
function patchTableOverflowNet(): void {
  const xform = TableXform as unknown as { prototype: { parseClose: TableParseClose } };
  const original = xform.prototype?.parseClose;

  if (typeof original !== 'function') {
    console.warn(
      '[uploads] ExcelJS TableXform.parseClose no tiene la forma esperada; ' +
        'la red del filtro de columnas no se aplicó.',
    );
    return;
  }

  const patched: TableParseClose = function patchedParseClose(name) {
    /*
     * SÓLO al cerrar `</table>`, que es cuando el original hace la copia por
     * índice. `parseClose` se llama también en cada cierre intermedio, y ahí la
     * lista de columnas todavía está vacía: recortar en ese momento dejaría el
     * autoFilter en cero SIEMPRE, en todos los archivos, y con un aviso falso.
     */
    if (name !== 'table') return original.call(this, name);

    const autoFilterColumns = this.map?.autoFilter?.model?.columns;
    const tableColumns = this.map?.tableColumns?.model;

    if (
      Array.isArray(autoFilterColumns) &&
      Array.isArray(tableColumns) &&
      autoFilterColumns.length > tableColumns.length
    ) {
      console.warn(
        `[uploads] tabla de Excel con ${autoFilterColumns.length} columnas de autoFilter ` +
          `y sólo ${tableColumns.length} columnas parseadas. Se recortan para poder leer el ` +
          'archivo, pero esto no debería pasar con el parche de tableColumn puesto: ' +
          'conviene revisar qué trae ese XML.',
      );
      this.map!.autoFilter!.model!.columns = autoFilterColumns.slice(0, tableColumns.length);
    }

    return original.call(this, name);
  };

  xform.prototype.parseClose = patched;
}
