/**
 * Reglas de parseo POR FUENTE.
 *
 * La configuración operativa (dataset y tabla destino, modo de carga, filas
 * mínimas, hoja) vive en `uploads.source` en Supabase, para que se pueda
 * cambiar sin desplegar. Lo que vive acá es lo que NO es configuración: las
 * particularidades de cada archivo, que requieren código.
 *
 * Una fuente nueva necesita las dos cosas: su fila en `uploads.source` y su
 * entrada acá. Es a propósito -- un archivo de origen nuevo siempre trae sus
 * propias rarezas, y descubrirlas es parte de agregarlo.
 */

export type SourceRules = {
  /**
   * Columnas que TIENEN que estar presentes en el encabezado, con el nombre
   * crudo tal como viene en el archivo (antes de normalizar). Si falta alguna,
   * la carga se aborta sin tocar BigQuery.
   */
  requiredColumns: string[];
  /**
   * Columna que no puede venir vacía. Las filas donde esté vacía se descartan
   * ANTES de contar, porque son basura de la conversión, no datos.
   */
  requireNonEmpty?: string;
  /**
   * Cantidad de columnas que se espera hoy. Informativa: se reporta y se
   * registra, pero no falla la carga -- que la fuente agregue una columna es
   * normal y no debería frenar la operación.
   */
  expectedColumnCount?: number;
};

export const SOURCE_RULES: Record<string, SourceRules> = {
  encompass: {
    /*
     * Las cinco columnas que identifican al export de Encompass y a la hoja
     * correcta dentro del archivo. No es la lista de las 58: es el conjunto
     * mínimo que un archivo equivocado -- u otra hoja del mismo archivo -- no
     * puede tener por casualidad. Que falte una columna del medio no se atrapa
     * acá a propósito; eso lo reporta expectedColumnCount sin frenar la carga.
     */
    requiredColumns: [
      'Loan Number',
      'Loan Officer',
      'LOAN INFO CHANNEL',
      'LAST FINISHED MILESTONE',
      'HELOC LIEN POSITION',
    ],
    // La conversión genera filas vacías al final: sin Loan Number no es un préstamo.
    requireNonEmpty: 'Loan Number',
    expectedColumnCount: 58,
  },
};

export function getSourceRules(sourceKey: string): SourceRules {
  const rules = SOURCE_RULES[sourceKey];
  if (!rules) {
    throw new Error(
      `source "${sourceKey}" has no parse rules in lib/uploads/sources.ts; ` +
        'add them before enabling it in uploads.source',
    );
  }
  return rules;
}

/**
 * Convierte un nombre de columna crudo en un nombre válido de BigQuery.
 *
 * El export de Encompass trae encabezados como 'EST CLOSING DATE [763]', con
 * espacios, guiones y corchetes. BigQuery los rechaza salvo que se habilite el
 * character map V2 al cargar. Se normaliza en el código en vez de delegar en esa
 * opción para que el nombre final sea explícito y estable: con V2 el mapeo lo
 * decide Google y cambia si cambia su implementación, y las vistas de
 * `lending_marts` que consumen la tabla quedarían atadas a eso.
 *
 *   'EST CLOSING DATE [763]' -> 'est_closing_date_763'
 *   'Loan Number'            -> 'loan_number'
 */
export function normalizeColumnName(raw: string): string {
  let name = raw
    .trim()
    .toLowerCase()
    // Todo lo que no sea letra o dígito pasa a ser separador.
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  // BigQuery no permite nombres que empiecen con dígito.
  if (/^[0-9]/.test(name)) name = `_${name}`;
  // Un encabezado que era puro puntuación queda vacío: hay que darle algo.
  if (!name) name = 'column';

  return name;
}

/**
 * Normaliza una lista de encabezados garantizando unicidad.
 *
 * Dos encabezados distintos pueden colapsar en el mismo nombre normalizado
 * ('Rate %' y 'Rate' -> 'rate'). Sin desambiguar, la segunda columna
 * sobrescribiría la primera en silencio y se perderían datos sin ningún error.
 */
export function normalizeHeaders(rawHeaders: string[]): string[] {
  const seen = new Map<string, number>();

  return rawHeaders.map((raw) => {
    const base = normalizeColumnName(raw);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}
