/**
 * ExcelJS no publica tipos para sus módulos internos, y `excelTablePatch.ts`
 * necesita uno de ellos para arreglar un defecto de la librería que impide leer
 * el archivo de RRHH. Ver el comentario de ese archivo para el porqué.
 *
 * Se declara SÓLO el módulo que se toca, y sin describir su forma: el parche ya
 * comprueba en tiempo de ejecución que `parseClose` exista antes de envolverlo,
 * porque un tipo inventado acá no probaría nada sobre lo que hay en disco.
 */
declare module 'exceljs/lib/xlsx/xform/table/table-column-xform.js' {
  const TableColumnXform: unknown;
  export default TableColumnXform;
}

declare module 'exceljs/lib/xlsx/xform/table/table-xform.js' {
  const TableXform: unknown;
  export default TableXform;
}
