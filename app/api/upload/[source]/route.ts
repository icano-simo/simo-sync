/**
 * Carga de un archivo de fuente externa a BigQuery.
 *
 * Secuencia, en este orden:
 *   1. sesión + allowed_apps
 *   2. la fuente está asignada A ESTE usuario (no se confía en la UI)
 *   3. recibir el archivo
 *   4. parsear según la configuración de uploads.source
 *   5. VALIDAR -- si falla, no se toca BigQuery
 *   6. cargar con WRITE_TRUNCATE
 *   7. verificar leyendo el conteo de vuelta
 *   8. registrar en load_log
 *   9. devolver el resultado
 *
 * La validación va ANTES de escribir a propósito: `WRITE_TRUNCATE` reemplaza la
 * tabla entera, así que un archivo corto o con la hoja equivocada no deja datos
 * parciales -- borra los buenos y pone basura. Por eso también se aborta entero
 * y nunca a medias.
 */
import { after, type NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { getSessionUser } from '@/lib/auth/session';
import { hasAppAccess } from '@/lib/auth/appAccess';
import { getServerClient } from '@/lib/supabase/server';
import { getBigQueryWriterClient, assertWritableDataset } from '@/lib/bigquery-writer';
import { getSourceRules, hasSourceRules, type SourceRules } from '@/lib/uploads/sources';
import { parseXlsx, parseCsv, dropColumns, type ParsedFile } from '@/lib/uploads/parse';
import {
  newBatchStamp,
  reservedCollisions,
  withBatchMetadata,
  METADATA_FIELDS,
  RESERVED_COLUMNS,
  UPLOAD_BATCH_ID,
  type LoadRow,
} from '@/lib/uploads/loadMetadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Parsear ~5,000 filas y esperar el load job de BigQuery no entra en el default.
export const maxDuration = 300;

/**
 * ============================================================================
 * DISPARO DEL SYNC DESPUÉS DE UNA CARGA
 * ============================================================================
 *
 * La app de Commercial Activity dejó de leer un archivo cargado a mano y ahora
 * lee `activity_report.loan_records_v2`, que se llena desde BigQuery en el cron
 * de las 08:00 UTC. Sin esto, un Encompass subido a las 3 de la tarde no se ve
 * hasta el día siguiente -- una regresión frente a la carga directa anterior.
 *
 * SÓLO PARA LAS FUENTES QUE ALIMENTAN UNA TABLA SINCRONIZADA. Los rosters, Blast
 * y las de Compensafe escriben tablas que el sync no lee, así que dispararlo por
 * ellas serían 20 segundos de trabajo para nada.
 *
 * LO QUE ESTO NO ARREGLA: sólo acelera lo que viene de Encompass. Si el dato que
 * falta viene de Salesforce -- una oportunidad, un realtor, una estrategia --
 * hay que esperar igual al transfer de la 1:03 AM, que no controlamos. Correr el
 * sync antes de eso no lo adelanta: leería de BigQuery lo mismo que ya está.
 */
const SYNC_AFTER_UPLOAD = new Set(['encompass']);

/** Cuánto se espera para poder CONTAR qué pasó. El sync sigue si no contesta. */
const SYNC_CONFIRM_MS = 5_000;
/** Techo del disparo. El sync completo tarda ~20s; esto es sólo un corte sano. */
const SYNC_TIMEOUT_MS = 120_000;

type SyncTrigger = {
  /** ¿Se llegó a llamar al sync? */
  disparado: boolean;
  /** ¿Contestó dentro de SYNC_CONFIRM_MS? Si no, sigue corriendo. */
  confirmado: boolean;
  /** Resultado del sync, cuando alcanzó a contestar. */
  ok: boolean | null;
  error: string | null;
};

/**
 * Llama al endpoint del cron sobre el propio origen.
 *
 * Se hace por HTTP y no importando la lógica del sync por dos razones: queda una
 * sola ruta de autorización -- la misma cabecera que usa el cron, y no un
 * segundo camino que pueda divergir -- y corre como su propia invocación, con su
 * propio presupuesto de tiempo, en vez de gastar el de esta carga.
 *
 * Funciona porque `/api/sync` está EXCLUIDA del matcher del gate (ver proxy.ts):
 * si pasara por ahí, esta llamada sin cookie de sesión se llevaría un 401.
 *
 * NUNCA RECHAZA. Devuelve el fallo como dato, porque quien la llama ya tiene una
 * carga exitosa en la mano y ninguna falla de acá puede convertirla en un error.
 */
async function triggerSync(origin: string, secret: string): Promise<SyncTrigger> {
  try {
    const res = await fetch(`${origin}/api/sync`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        disparado: true,
        confirmado: true,
        ok: false,
        error: `sync responded ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    return { disparado: true, confirmado: true, ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { disparado: true, confirmado: true, ok: false, error: message };
  }
}

type SourceConfig = {
  source_key: string;
  display_name: string;
  target_dataset: string;
  target_table: string;
  load_mode: string;
  min_rows_expected: number;
  sheet_name: string | null;
  is_active: boolean;
  /** Fila del encabezado, 1-based. null = la 1. */
  header_row: number | null;
  /** Obligatorias, con el nombre CRUDO del archivo. Sin esto la carga se niega. */
  required_columns: string[] | null;
  /** A descartar antes de escribir, con el nombre YA NORMALIZADO. */
  drop_columns: string[] | null;
};

type LogStatus = 'ok' | 'validation_failed' | 'error';

/** Deja constancia del intento. Nunca hace fallar la respuesta. */
async function writeLog(
  sb: Awaited<ReturnType<typeof getServerClient>>,
  entry: {
    source_key: string;
    user_email: string;
    file_name: string;
    rows_loaded: number | null;
    status: LogStatus;
    error_message: string | null;
  },
): Promise<void> {
  const { error } = await sb.from('load_log').insert(entry);
  if (error) {
    // Si no se pudo registrar, se avisa por log del servidor pero no se
    // convierte en el error que ve el usuario: la carga ya ocurrió (o ya
    // falló) y ese resultado es más importante que su bitácora.
    console.error(`[upload] could not write load_log: ${error.message}`);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ source: string }> }) {
  const started = Date.now();
  const { source: sourceKey } = await ctx.params;

  // ---- 1. Sesión y acceso a la app -------------------------------------
  // El gate (proxy.ts) ya cubre esto, pero se repite acá: es la ruta que
  // escribe, y no debe depender de que el matcher del gate siga cubriéndola.
  let user: User | null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }

  if (!user) {
    return Response.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }
  if (!hasAppAccess(user)) {
    return Response.json({ ok: false, error: 'No access to this application' }, { status: 403 });
  }

  const userEmail = user.email;
  if (!userEmail) {
    return Response.json({ ok: false, error: 'Session has no email' }, { status: 403 });
  }

  const sb = await getServerClient('uploads');

  // ---- 2. Esta fuente está asignada a ESTE usuario ----------------------
  // No se confía en que la UI la haya ocultado: la lista de la UI y este
  // chequeo son dos cosas distintas, y sólo esta segunda protege los datos.
  // La consulta corre con la sesión del usuario, así que RLS la acota además
  // por su cuenta.
  const { data: assignment, error: assignmentError } = await sb
    .from('user_source')
    .select('source_key')
    .eq('user_email', userEmail)
    .eq('source_key', sourceKey)
    .maybeSingle();

  if (assignmentError) {
    return Response.json(
      { ok: false, error: `could not verify assignment: ${assignmentError.message}` },
      { status: 500 },
    );
  }
  if (!assignment) {
    // 403 y no 404: existir o no la fuente no es asunto de quien no la tiene.
    return Response.json(
      { ok: false, error: `not authorized for source "${sourceKey}"` },
      { status: 403 },
    );
  }

  // Configuración de la fuente.
  const { data: sourceRow, error: sourceError } = await sb
    .from('source')
    .select('*')
    .eq('source_key', sourceKey)
    .eq('is_active', true)
    .maybeSingle<SourceConfig>();

  if (sourceError) {
    return Response.json(
      { ok: false, error: `could not read source config: ${sourceError.message}` },
      { status: 500 },
    );
  }
  if (!sourceRow) {
    return Response.json(
      { ok: false, error: `source "${sourceKey}" is not configured or not active` },
      { status: 404 },
    );
  }

  const rules: SourceRules = getSourceRules(sourceKey);

  /*
   * Las columnas obligatorias ahora viven en `uploads.source`, así que una fila
   * sin ellas dejaría la validación en nada -- y la carga es WRITE_TRUNCATE:
   * un archivo equivocado no dejaría datos parciales, borraría los buenos. Se
   * niega antes de recibir el archivo, para no hacer subir varios MB y recién
   * después decir que la fuente está mal configurada.
   *
   * Una fuente que de verdad no tenga columnas obligatorias no está
   * contemplada: hoy eso es siempre una fila a medio configurar.
   */
  const requiredColumns = sourceRow.required_columns ?? [];
  if (requiredColumns.length === 0) {
    return Response.json(
      {
        ok: false,
        stage: 'config',
        error:
          `source "${sourceKey}" has no required_columns in uploads.source; ` +
          'refusing to load without column validation',
      },
      { status: 500 },
    );
  }

  const headerRow = sourceRow.header_row ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    return Response.json(
      {
        ok: false,
        stage: 'config',
        error: `source "${sourceKey}" has an invalid header_row (${sourceRow.header_row})`,
      },
      { status: 500 },
    );
  }

  // ---- 3. Recibir el archivo -------------------------------------------
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

    // ---- 4. Parsear según la configuración -----------------------------
    const parseOptions = { headerRow, requireNonEmpty: rules.requireNonEmpty };

    if (isXlsx) {
      parsed = await parseXlsx(await file.arrayBuffer(), sourceRow.sheet_name, parseOptions);
    } else {
      parsed = parseCsv(await file.text(), parseOptions);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: null,
      status: 'error',
      error_message: `parse failed: ${message}`,
    });
    return Response.json({ ok: false, stage: 'parse', error: message }, { status: 400 });
  }

  // ---- 5. Validar ANTES de tocar BigQuery ------------------------------
  const problems: string[] = [];

  if (parsed.rows.length < sourceRow.min_rows_expected) {
    problems.push(
      `expected at least ${sourceRow.min_rows_expected} rows, got ${parsed.rows.length}`,
    );
  }

  // Se compara contra el nombre CRUDO -- `required_columns` describe el archivo
  // que llegó, no la tabla que se va a crear. `drop_columns` es al revés.
  const present = new Set(parsed.rawHeaders.map((h) => h.trim().toLowerCase()));
  const missing = requiredColumns.filter((c) => !present.has(c.trim().toLowerCase()));
  if (missing.length) {
    problems.push(`missing expected column(s): ${missing.join(', ')}`);
  }

  if (problems.length) {
    const message = problems.join('; ');
    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: null,
      status: 'validation_failed',
      error_message: message,
    });
    // 422: el archivo llegó bien, su contenido es lo que no sirve.
    return Response.json(
      {
        ok: false,
        stage: 'validation',
        error: message,
        detalle: {
          filas_encontradas: parsed.rows.length,
          filas_minimas: sourceRow.min_rows_expected,
          filas_descartadas: parsed.discardedRows,
          columnas_encontradas: parsed.rawHeaders.length,
          columnas_faltantes: missing,
        },
      },
      { status: 422 },
    );
  }

  // ---- 5b. Descartar columnas que no deben llegar a BigQuery -----------
  /*
   * Después de validar (la validación mira el archivo completo) y antes de
   * escribir. Lo que se descarta acá no viaja en el NDJSON ni aparece en el
   * esquema: no existe en la tabla, ni siquiera como columna vacía.
   */
  const drop = dropColumns(parsed, sourceRow.drop_columns ?? []);

  /*
   * Un nombre de `drop_columns` que no está en el archivo se trata como error y
   * NO como un aviso. Las dos causas posibles piden que alguien mire antes de
   * escribir: o la config tiene un typo -- y entonces la columna que se quería
   * dejar afuera se cargaría igual -- o el archivo cambió de forma. Con datos
   * sensibles, cargar primero y descubrirlo después es el orden equivocado, y
   * como la carga es WRITE_TRUNCATE, reintentar después de corregir no cuesta
   * nada.
   */
  if (drop.notFound.length) {
    const message =
      `drop_columns not present in the file: ${drop.notFound.join(', ')}; ` +
      'fix uploads.source or check whether the source file changed shape';
    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: null,
      status: 'validation_failed',
      error_message: message,
    });
    return Response.json(
      {
        ok: false,
        stage: 'drop_columns',
        error: message,
        detalle: {
          columnas_del_archivo: parsed.headers.length,
          descartadas_encontradas: drop.dropped,
          descartadas_no_encontradas: drop.notFound,
        },
      },
      { status: 422 },
    );
  }

  const toLoad = drop.parsed;

  /*
   * Un archivo que traiga una columna que normalice a `upload_batch_id`,
   * `uploaded_at` o `row_index` chocaría con la que escribe el cargador: misma
   * clave en el JSON y campo duplicado en el esquema, con uno de los dos
   * ganando en silencio. Se rechaza antes de escribir.
   *
   * Se chequea SIEMPRE, no sólo en 'append': una fuente puede pasar a acumular
   * después, y descubrir la colisión recién ahí es descubrirla tarde.
   */
  const collisions = reservedCollisions(toLoad.headers);
  if (collisions.length) {
    const message =
      `file column(s) collide with the loader's own columns: ${collisions.join(', ')}; ` +
      `reserved: ${RESERVED_COLUMNS.join(', ')}`;
    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: null,
      status: 'validation_failed',
      error_message: message,
    });
    return Response.json({ ok: false, stage: 'reserved_columns', error: message }, { status: 422 });
  }

  /*
   * El lote se sella ACÁ y no dentro del try: el mismo `upload_batch_id` y el
   * mismo `uploaded_at` tienen que ir en todas las filas de esta carga y en la
   * consulta que la verifica después.
   */
  const batch = newBatchStamp();

  // ---- 6-8. Cargar, verificar, registrar -------------------------------
  try {
    assertWritableDataset(sourceRow.target_dataset);

    /*
     * 'replace' reescribe la tabla entera; 'append' agrega esta carga a lo que
     * ya hay. Son dos modelos distintos, no una optimización: una fuente que
     * acumula períodos ya cerrados no puede reemplazar, porque reescribiría
     * historia que no cambia y de la que cuelgan datos de otras apps.
     */
    const isAppend = sourceRow.load_mode === 'append';
    if (sourceRow.load_mode !== 'replace' && !isAppend) {
      throw new Error(
        `unsupported load_mode "${sourceRow.load_mode}"; expected "replace" or "append"`,
      );
    }

    const bq = getBigQueryWriterClient();
    const table = bq.dataset(sourceRow.target_dataset).table(sourceRow.target_table);

    /*
     * Se escribe SIEMPRE desde `toLoad` -- el archivo ya sin las columnas de
     * `drop_columns` -- y nunca desde `parsed`.
     */
    const stamped = isAppend ? withBatchMetadata(toLoad, batch) : null;
    const loadRows: LoadRow[] = stamped ? stamped.rows : toLoad.rows;

    // Las columnas del archivo van todas STRING: es una tabla de staging y el
    // casteo vive en las vistas. Con autodetect, una columna que un día viene
    // vacía y otro trae texto cambiaría de tipo sola y rompería las vistas de
    // golpe. Las tres del cargador van tipadas: las genera él, así que su tipo
    // no depende de lo que traiga el archivo.
    const schema = {
      fields: [
        ...toLoad.headers.map((name) => ({ name, type: 'STRING' })),
        ...(stamped ? METADATA_FIELDS.map((f) => ({ name: f.name, type: f.type as string })) : []),
      ],
    };

    /*
     * Guarda redundante con `toLoad`, y existe justamente por eso: una
     * sustitución mal aplicada ya dejó una vez esta escritura leyendo `parsed`
     * en lugar de `toLoad`. `drop_columns` se calculaba, se reportaba y se
     * abortaba por typos igual, el tipo compilaba, y las columnas sensibles se
     * cargaban de todas formas. Esto convierte esa clase de error en una falla
     * ruidosa en vez de una fuga silenciosa.
     */
    const leaked = drop.dropped.filter((c) => schema.fields.some((f) => f.name === c));
    if (leaked.length) {
      throw new Error(
        `refusing to write: dropped column(s) reached the schema: ${leaked.join(', ')}`,
      );
    }

    const ndjson = loadRows.map((r) => JSON.stringify(r)).join('\n');

    await new Promise<void>((resolve, reject) => {
      const stream = table.createWriteStream({
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: isAppend ? 'WRITE_APPEND' : 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_IF_NEEDED',
        schema,
      });
      stream.on('error', reject);
      // 'job complete' es el evento que garantiza que el load job terminó;
      // 'finish' sólo dice que se subieron los bytes.
      stream.on('complete', () => resolve());
      stream.end(Buffer.from(ndjson, 'utf8'));
    });

    // ---- 7. Verificar leyendo de vuelta --------------------------------
    /*
     * En 'append' se cuenta SÓLO este lote. Contar la tabla entera compararía
     * todos los meses acumulados contra las filas de uno: daría distinto
     * siempre, y una carga buena quedaría registrada como error.
     */
    const fq = `\`${bq.projectId}.${sourceRow.target_dataset}.${sourceRow.target_table}\``;
    const [countRows] = isAppend
      ? await bq.query({
          query: `SELECT COUNT(*) AS n FROM ${fq} WHERE ${UPLOAD_BATCH_ID} = @batch`,
          params: { batch: batch.uploadBatchId },
        })
      : await bq.query({ query: `SELECT COUNT(*) AS n FROM ${fq}` });
    const rowsInTable = Number(countRows?.[0]?.n ?? 0);
    // El descarte quita COLUMNAS, nunca filas: el conteo esperado sigue siendo
    // el del archivo parseado.
    const matches = rowsInTable === toLoad.rows.length;

    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: rowsInTable,
      status: matches ? 'ok' : 'error',
      error_message: matches
        ? null
        : `row count mismatch: parsed ${toLoad.rows.length}, table has ${rowsInTable}`,
    });

    // ---- 9. Disparar el sync, sin dejar que afecte a esta carga ----------
    /*
     * Sólo si la carga fue buena y sólo para las fuentes que alimentan una tabla
     * sincronizada. Un `matches` falso significa que la tabla no quedó como
     * esperábamos: sincronizar eso a Supabase propagaría el problema.
     *
     * `after()` mantiene viva la invocación hasta que el sync termine, aunque la
     * respuesta ya se haya ido. Sin eso, en serverless la función puede quedar
     * congelada al responder y cortar el fetch a mitad de camino.
     *
     * Y se corre igual una carrera contra SYNC_CONFIRM_MS para poder decir en la
     * respuesta qué pasó: si el sync contesta rápido, el usuario se entera acá
     * mismo; si no, se le dice que quedó disparado y sigue. Nunca se lo hace
     * esperar los ~20 segundos completos.
     */
    let sync: SyncTrigger = { disparado: false, confirmado: false, ok: null, error: null };

    if (matches && SYNC_AFTER_UPLOAD.has(sourceKey)) {
      const secret = process.env.CRON_SECRET;

      if (!secret) {
        // No es un fallo de la carga: el archivo ya está en BigQuery.
        sync = {
          disparado: false,
          confirmado: false,
          ok: null,
          error: 'CRON_SECRET is not configured; the nightly cron will pick it up',
        };
        console.error('[upload] cannot trigger sync: CRON_SECRET is not set');
      } else {
        const running = triggerSync(req.nextUrl.origin, secret).then((result) => {
          // El log del servidor es el único registro duradero de esto: la
          // respuesta se la lleva el navegador y `load_log` ya se escribió.
          if (!result.ok) {
            console.error(`[upload] sync after ${sourceKey} failed: ${result.error}`);
          } else {
            console.log(`[upload] sync after ${sourceKey} completed`);
          }
          return result;
        });

        after(() => running);

        const settled = await Promise.race([
          running,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_CONFIRM_MS)),
        ]);

        sync = settled ?? { disparado: true, confirmado: false, ok: null, error: null };
      }
    }

    return Response.json(
      {
        ok: matches,
        fuente: sourceRow.display_name,
        archivo: fileName,
        destino: `${sourceRow.target_dataset}.${sourceRow.target_table}`,
        modo: sourceRow.load_mode,
        sync_disparado: sync.disparado,
        sync,
        // Sólo en 'append': en 'replace' la tabla entera es la carga.
        upload_batch_id: isAppend ? batch.uploadBatchId : null,
        filas_parseadas: toLoad.rows.length,
        filas_en_tabla: rowsInTable,
        filas_descartadas: parsed.discardedRows,
        columnas_del_archivo: parsed.headers.length,
        columnas_cargadas: toLoad.headers.length,
        columnas_descartadas: drop.dropped,
        columnas_esperadas: rules.expectedColumnCount ?? null,
        fila_encabezado: headerRow,
        reglas_en_codigo: hasSourceRules(sourceKey),
        coincide: matches,
        duracion_ms: Date.now() - started,
      },
      { status: matches ? 200 : 500 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[upload] ${sourceKey} failed: ${message}`);
    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: null,
      status: 'error',
      error_message: message,
    });
    return Response.json({ ok: false, stage: 'load', error: message }, { status: 500 });
  }
}
