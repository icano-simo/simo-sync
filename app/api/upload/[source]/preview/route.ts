/**
 * ============================================================================
 * PREVIO DE COLUMNAS: qué columnas trae el archivo, antes de cargarlo
 * ============================================================================
 *
 * Lee el archivo y devuelve sus columnas con el nombre ORIGINAL y el
 * NORMALIZADO. Nada más.
 *
 * POR QUÉ EXISTE. El 2 de septiembre `roster_co` necesitó cinco intentos y
 * `hr_hiring` tres, todos por lo mismo: `uploads.source` tenía un nombre de
 * columna que el archivo no usa, y la única forma de enterarse era fallar.
 * 'Branch #' contra 'Branch'. 'unnamed_38' contra 'column_2'. '#' contra
 * 'column'. Con las columnas a la vista, quien sube el archivo ve la diferencia
 * sin necesitar a nadie.
 *
 * ⚠ ESTA RUTA NO ESCRIBE NADA. No BigQuery, no `load_log`, no Supabase más allá
 * de LEER quién llama y cómo está configurada la fuente. No importa
 * `bigquery-writer` ni `loadMetadata`, y eso es a propósito: el previo se va a
 * llamar en cada `change` del <input type="file">, muchas más veces que una
 * carga, y un previo que pudiera tocar la tabla destino convertiría "elegir un
 * archivo" en una operación peligrosa. Si algún día hace falta que registre
 * algo, va a otra tabla y con su propio nombre -- `load_log` es la bitácora de
 * lo que se cargó, y un previo no carga.
 *
 * ⚠ NO VALIDA NI CORRIGE. No dice si una columna falta, si sobra o si el nombre
 * está mal. Decidir qué columna es cuál sigue siendo de quien configura la
 * fuente; esta ruta sólo muestra lo que hay. La única excepción está abajo, en
 * `drop_columns`, y tiene su motivo escrito.
 *
 * MISMO PARSER, MISMA CONFIGURACIÓN. Usa `authorizeSource` y `resolveHeaderRow`
 * --las mismas que la carga-- y `parseXlsx` / `parseCsv` con las mismas
 * opciones. No hay una segunda implementación que pueda mostrar algo distinto de
 * lo que se carga: un previo que miente es peor que no tener previo, porque hoy
 * quien sube el archivo al menos sabe que no sabe.
 */
import type { NextRequest } from 'next/server';
import { parseXlsx, parseCsv, dropColumns, type ParsedFile } from '@/lib/uploads/parse';
import { authorizeSource, resolveHeaderRow } from '@/lib/uploads/authorizeSource';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * El previo parsea el archivo COMPLETO, igual que la carga, y por eso tarda
 * parecido a su paso de parseo. Se podría leer sólo la fila del encabezado y
 * salir antes, pero eso sería un segundo camino de lectura que puede divergir
 * del real -- justo lo que esta ruta existe para no hacer. El costo es unos
 * segundos en el archivo más grande (Encompass); la contrapartida es que las
 * columnas mostradas son EXACTAMENTE las que va a usar la carga.
 */
export const maxDuration = 120;

/** Una columna del archivo, con los dos nombres. */
type PreviewColumn = {
  /** 1-based, para poder decir "la columna 38" y que coincida con Excel. */
  posicion: number;
  /** Como viene en el archivo. */
  original: string;
  /** Como va a llamarse en BigQuery. */
  normalizado: string;
  /** Si `drop_columns` la descarta antes de escribir. Ver la nota de abajo. */
  se_descarta: boolean;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ source: string }> }) {
  const { source: sourceKey } = await ctx.params;

  const auth = await authorizeSource(sourceKey);
  if (!auth.ok) return auth.response;

  const { sourceRow, rules } = auth.ctx;

  /*
   * Un `header_row` mal puesto se reporta y no se adivina: leyendo la fila 1 "por
   * si acaso" el previo mostraría columnas de una fila distinta de la que usaría
   * la carga, que es la única cosa que este endpoint no puede permitirse.
   *
   * Ojo: acá NO se exige `required_columns`, aunque la carga sí lo haga. Una
   * fuente a medio configurar es justamente cuando más sirve ver las columnas:
   * negarse a mostrarlas obligaría a adivinar los nombres para poder
   * configurarla.
   */
  const headerRow = resolveHeaderRow(sourceRow);
  if (headerRow === null) {
    return Response.json(
      {
        ok: false,
        stage: 'config',
        error: `source "${sourceKey}" has an invalid header_row (${sourceRow.header_row})`,
      },
      { status: 500 },
    );
  }

  let fileName = '(unknown)';
  let parsed: ParsedFile;

  try {
    const form = await req.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return Response.json({ ok: false, error: 'no file in request' }, { status: 400 });
    }

    fileName = file.name;
    const lower = fileName.toLowerCase();
    const isXlsx = lower.endsWith('.xlsx');
    const isCsv = lower.endsWith('.csv');

    if (!isXlsx && !isCsv) {
      return Response.json(
        { ok: false, error: 'unsupported file type; expected .xlsx or .csv' },
        { status: 400 },
      );
    }

    const parseOptions = { headerRow, requireNonEmpty: rules.requireNonEmpty };

    if (isXlsx) {
      parsed = await parseXlsx(await file.arrayBuffer(), sourceRow.sheet_name, parseOptions);
    } else {
      parsed = parseCsv(await file.text(), parseOptions);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /*
     * El fallo del previo NO se registra en `load_log`: no hubo intento de
     * carga. Y el 400 que sale de acá no bloquea nada -- la UI lo muestra como
     * aviso y el botón de Subir sigue habilitado, porque el previo es una ayuda
     * y no un permiso.
     */
    return Response.json({ ok: false, stage: 'parse', error: message }, { status: 400 });
  }

  /*
   * QUÉ COLUMNAS DESCARTA `drop_columns`, MARCADAS UNA POR UNA.
   *
   * Es lo único que este endpoint dice sobre la configuración, y va acá por una
   * razón que no aplica al resto: un `drop_columns` que no coincide NO FALLA. La
   * carga sale bien y la columna sensible del roster de Colombia --cédula,
   * cuenta bancaria, dirección-- se escribe a BigQuery igual. Todos los demás
   * desajustes de nombres se anuncian solos al fallar la carga; éste es el único
   * que se anuncia no pasando nada.
   *
   * Sigue sin ser una validación: no dice que algo esté mal, dice qué columna
   * está en la lista y qué nombre de la lista no encontró ninguna. Con eso a la
   * vista, un nombre que no coincide se ve antes de subir en vez de descubrirse
   * en una tabla que ya tiene el dato.
   *
   * Se llama a `dropColumns`, la misma función de la carga, en vez de comparar
   * los nombres acá: reimplementar la comparación sería una segunda semántica
   * que puede divergir, y el costo de reconstruir las filas es despreciable al
   * lado del parseo que ya se hizo.
   */
  const configuredDrop = sourceRow.drop_columns ?? [];
  const { dropped, notFound } = dropColumns(parsed, configuredDrop);
  const droppedSet = new Set(dropped);

  const columnas: PreviewColumn[] = parsed.headers.map((normalizado, i) => ({
    posicion: i + 1,
    original: parsed.rawHeaders[i] ?? '',
    normalizado,
    se_descarta: droppedSet.has(normalizado),
  }));

  return Response.json({
    ok: true,
    archivo: fileName,
    // Lo que se leyó, para que se vea de dónde salen estas columnas.
    hoja: sourceRow.sheet_name,
    fila_encabezado: headerRow,
    filas: parsed.rows.length,
    filas_descartadas: parsed.discardedRows,
    columnas,
    /** Nombres de `drop_columns` que no coinciden con ninguna columna del archivo. */
    drop_sin_coincidencia: notFound,
  });
}
