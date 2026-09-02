import type { ParsedFile } from './parse';

/**
 * ============================================================================
 * FILTRO DE DIVISIÓN — descartar antes de escribir, no después
 * ============================================================================
 *
 * El export de RRHH de USA llega COMPLETO: 1.405 personas de 214 branches, todo
 * Supreme y no sólo la división. Filtrarlo en una vista de BigQuery significaría
 * guardar ahí el directorio de 1.302 personas de otras divisiones, con nombre,
 * correo, teléfono y dirección. No las necesitamos, así que no entran.
 *
 * EL PREFIJO ES NECESARIO PERO NO SUFICIENTE. 24 branches empiezan con 7 y sólo
 * 15 son de la división; los otros 9 ya están decididos como ajenos. Por eso la
 * regla no puede ser sólo el prefijo y hay una tabla de decisiones.
 *
 * ⚠ UN BRANCH SIN DECIDIR ENTRA IGUAL. Ese es el punto de todo esto: si un
 * branch nuevo se descartara por no estar en la lista, nadie se enteraría de que
 * existe. Entra, y la carga lo reporta como pendiente para que alguien decida.
 * El costo de equivocarse en esa dirección es unas pocas personas de más en
 * BigQuery por unos días; en la otra, un branch de la división invisible para
 * siempre.
 */

/** Regla por fuente. Vive en `sources.ts` porque es comportamiento, no una lista. */
export type DivisionRule = {
  /** Columna del código de branch, con el nombre YA NORMALIZADO. */
  branchColumn: string;
  /** Prefijo de los branches de la división. */
  prefix: string;
};

/** Una fila de `uploads.branch_division_decision`. */
export type DivisionDecision = {
  branch_code: string;
  in_division: boolean;
};

/** Un branch que apareció en el archivo y nadie decidió todavía. */
export type PendingBranch = {
  branch_code: string;
  /** Cuánta gente trae, que es lo que hace que valga la pena decidirlo. */
  people: number;
};

/**
 * Resumen de lo que NO se cargó.
 *
 * Los tres motivos van por separado y no sumados: "otra división" es lo
 * esperado, "descartado" es una decisión tomada, y "sin branch" es un dato malo.
 * Un solo total los haría indistinguibles y el tercero es el único que pide que
 * alguien mire el archivo.
 */
export type DivisionFilterSummary = {
  otra_division: number;
  descartado: number;
  sin_branch: number;
  /** Cuántos branches distintos se descartaron por no tener el prefijo. */
  branches_otra_division: number;
};

export type DivisionFilterResult = {
  /** El archivo, con sólo las filas que entran. */
  parsed: ParsedFile;
  summary: DivisionFilterSummary;
  pending: PendingBranch[];
};

/**
 * Parte las filas en las que entran y las que no.
 *
 * No lanza por datos: un branch raro es un dato, no una excepción. Lo que sí
 * exige es que la columna del branch exista -- ver `hasBranchColumn`, que la
 * ruta chequea antes de llamar acá.
 */
export function filterByDivision(
  parsed: ParsedFile,
  rule: DivisionRule,
  decisions: DivisionDecision[],
): DivisionFilterResult {
  const decisionByBranch = new Map(
    decisions.map((d) => [d.branch_code.trim(), d.in_division]),
  );

  const kept: ParsedFile['rows'] = [];
  const summary: DivisionFilterSummary = {
    otra_division: 0,
    descartado: 0,
    sin_branch: 0,
    branches_otra_division: 0,
  };
  const otherBranches = new Set<string>();
  const pendingPeople = new Map<string, number>();

  for (const row of parsed.rows) {
    const branch = String(row[rule.branchColumn] ?? '').trim();

    if (branch === '') {
      // Sin branch no se puede decidir sobre esa persona, así que cargarla la
      // dejaría en un limbo: en BigQuery y sin poder atribuirla. Se descarta,
      // pero con su propio contador -- si aparece, alguien tiene que mirar el
      // archivo.
      summary.sin_branch++;
      continue;
    }

    if (!branch.startsWith(rule.prefix)) {
      summary.otra_division++;
      otherBranches.add(branch);
      continue;
    }

    const decision = decisionByBranch.get(branch);

    if (decision === false) {
      summary.descartado++;
      continue;
    }

    if (decision === undefined) {
      // Sin decidir: ENTRA, y se cuenta para reportarlo.
      pendingPeople.set(branch, (pendingPeople.get(branch) ?? 0) + 1);
    }

    kept.push(row);
  }

  summary.branches_otra_division = otherBranches.size;

  const pending: PendingBranch[] = [...pendingPeople.entries()]
    .map(([branch_code, people]) => ({ branch_code, people }))
    .sort((a, b) => a.branch_code.localeCompare(b.branch_code));

  return {
    // Las columnas no cambian: el filtro quita FILAS, nunca campos.
    parsed: { ...parsed, rows: kept },
    summary,
    pending,
  };
}

/**
 * ¿Está la columna del branch en el archivo?
 *
 * Se chequea aparte y antes de filtrar porque su ausencia no es un dato raro:
 * sin ella toda fila quedaría "sin branch" y el filtro descartaría el archivo
 * completo, reportando 1.405 filas malas en lugar de decir que falta la columna.
 */
export function hasBranchColumn(parsed: ParsedFile, rule: DivisionRule): boolean {
  return parsed.headers.includes(rule.branchColumn);
}
