import type { DivisionRule } from './divisionFilter';

/**
 * Reglas de parseo POR FUENTE.
 *
 * La configuración operativa vive en `uploads.source` en Supabase, para que se
 * pueda cambiar sin desplegar: dataset y tabla destino, modo de carga, filas
 * mínimas, hoja, fila del encabezado (`header_row`), columnas obligatorias
 * (`required_columns`) y columnas a descartar (`drop_columns`).
 *
 * `required_columns` vivía acá y se movió a la tabla. Lo que queda es lo que no
 * se puede expresar como una lista en una fila: comportamiento que necesita
 * código.
 *
 * Una fuente puede existir SÓLO con su fila en `uploads.source`, sin entrada
 * acá: `getSourceRules` devuelve reglas vacías. Es lo que permite dar de alta
 * una fuente nueva sin desplegar. Cuando aparezca una rareza que la
 * configuración no cubra -- una columna guardia, un conteo esperado -- se le
 * agrega su entrada.
 */

export type SourceRules = {
  /**
   * Filtrar filas por división antes de escribir a BigQuery.
   *
   * Sólo la necesita `roster_us`, cuyo export llega con las 1.405 personas de
   * todo Supreme. Ver `lib/uploads/divisionFilter.ts` para por qué el filtro va
   * acá y no en una vista, y por qué un branch sin decidir entra igual.
   */
  divisionFilter?: DivisionRule;
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
  roster_us: {
    /*
     * El archivo trae todo Supreme y sólo entran los branches de la división.
     * La columna del branch es 'Br #' en el archivo, que normaliza a 'br'.
     *
     * ⚠ El prefijo NO alcanza como regla: 24 branches empiezan con 7 y sólo 15
     * son nuestros. Lo que decide es `uploads.branch_division_decision`; el
     * prefijo sólo evita preguntar por los 190 branches que claramente no son
     * de la división.
     */
    divisionFilter: { branchColumn: 'br', prefix: '7' },
  },
  encompass: {
    // La conversión genera filas vacías al final: sin Loan Number no es un préstamo.
    requireNonEmpty: 'Loan Number',
    expectedColumnCount: 58,
  },
};

/** Reglas de una fuente que no necesita nada especial del código. */
const NO_RULES: SourceRules = {};

/**
 * Reglas de código de una fuente, o vacías si no tiene.
 *
 * NO lanza cuando la fuente no está acá: eso bloquearía dar de alta una fuente
 * nueva sólo con su fila en `uploads.source`, que es justamente lo que
 * `required_columns` / `drop_columns` / `header_row` vinieron a habilitar. La
 * ruta reporta `reglas_en_codigo` para que quede visible cuál es el caso.
 */
export function getSourceRules(sourceKey: string): SourceRules {
  return SOURCE_RULES[sourceKey] ?? NO_RULES;
}

/** true si la fuente tiene una entrada propia acá. Sólo para reportarlo. */
export function hasSourceRules(sourceKey: string): boolean {
  return sourceKey in SOURCE_RULES;
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
 *   'Número de Cédula'       -> 'numero_de_cedula'
 *
 * LOS ACENTOS SE PLIEGAN A SU LETRA BASE, no se tratan como separador. Sin eso,
 * 'Número de Cédula' daba 'n_mero_de_c_dula': la 'ú' y la 'é' no están en a-z y
 * caían en la regla de "todo lo demás es separador". Además de ilegible, es
 * inconfigurable -- nadie escribe 'n_mero_de_c_dula' en `drop_columns` de
 * `uploads.source`, escribe 'numero_de_cedula', no coincide, y una columna
 * sensible del roster de Colombia se quedaría sin descartar. Y dos encabezados
 * distintos ('Año' y 'A o') colapsaban al mismo nombre por la misma razón.
 *
 * Verificado contra el archivo real de Encompass: sus 58 encabezados son todos
 * ASCII, así que este cambio NO mueve ningún nombre de `encompass_loans_stage`
 * ni de las vistas de `lending_marts` que ya la leen.
 */
export function normalizeColumnName(raw: string): string {
  let name = raw
    .trim()
    // NFD separa la letra de su diacrítico, y el rango los borra: 'é' -> 'e'.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
