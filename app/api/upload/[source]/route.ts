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
// Sólo para completar el resultado del sync en load_log; ver recordSyncOutcome.
import { getSupabaseClient as getAdminUploadsClient } from '@/lib/supabase-admin';
import { getBigQueryWriterClient, assertWritableDataset } from '@/lib/bigquery-writer';
import { hasSourceRules } from '@/lib/uploads/sources';
import {
  authorizeSource,
  resolveHeaderRow,
  type UploadsClient,
} from '@/lib/uploads/authorizeSource';
import { parseXlsx, parseCsv, dropColumns, type ParsedFile } from '@/lib/uploads/parse';
import {
  filterByDivision,
  hasBranchColumn,
  type DivisionDecision,
  type DivisionFilterResult,
  type DivisionFilterSummary,
  type PendingBranch,
} from '@/lib/uploads/divisionFilter';
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
 * SÓLO PARA LAS FUENTES QUE ALIMENTAN UNA TABLA SINCRONIZADA. Blast y las cuatro
 * de Compensafe escriben tablas que el sync no lee, así que dispararlo por ellas
 * serían 20 segundos de trabajo para nada.
 *
 *   encompass              -> activity_report.loan_records_v2  (Commercial Activity)
 *   pipeline               -> pipeline_forecast.*              (Forecast & Pipeline)
 *   roster_co / roster_us  -> org.roster_current               (Admin)
 *
 * En 'pipeline' pesa todavía más que en 'encompass': ese archivo se sube dos o
 * tres veces al día JUSTAMENTE porque hace falta el dato fresco. Esperar al cron
 * anularía el motivo de volver a subirlo.
 *
 * Los dos rosters disparan aunque escriban tablas de stage distintas
 * (`active_roster_stage` y `hr_usa_directory_stage`): la vista
 * `hr_centralizado.roster_for_admin`, que es lo que el sync lee, las une por
 * `person_code`. Subir el de un país no altera a las personas del otro -- la
 * vista calcula "sigue activa" contra el ÚLTIMO LOTE DE SU PROPIO PAÍS.
 *
 * LO QUE ESTO NO ARREGLA: sólo acelera lo que se sube por esta app. Si el dato
 * que falta viene de Salesforce -- una oportunidad, un realtor, una estrategia
 * -- hay que esperar igual al transfer de la 1:03 AM, que no controlamos.
 * Correr el sync antes de eso no lo adelanta: leería de BigQuery lo mismo que ya
 * está.
 */
const SYNC_AFTER_UPLOAD = new Set(['encompass', 'pipeline', 'roster_co', 'roster_us']);

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

type LogStatus = 'ok' | 'validation_failed' | 'error';

/**
 * Deja constancia del intento. Nunca hace fallar la respuesta.
 *
 * Devuelve el id de la fila para poder completarle después el resultado del
 * sync -- ver `recordSyncOutcome`. `null` si no se pudo registrar.
 */
async function writeLog(
  sb: UploadsClient,
  entry: {
    source_key: string;
    user_email: string;
    file_name: string;
    rows_loaded: number | null;
    status: LogStatus;
    error_message: string | null;
    /** Resumen de lo descartado por el filtro de división. Sólo roster_us. */
    division_filtered?: DivisionFilterSummary | null;
    /** Branches que aparecieron sin decidir. Es lo único accionable de la carga. */
    division_pending?: PendingBranch[] | null;
  },
): Promise<number | null> {
  const { data, error } = await sb.from('load_log').insert(entry).select('id').single();
  if (error) {
    // Si no se pudo registrar, se avisa por log del servidor pero no se
    // convierte en el error que ve el usuario: la carga ya ocurrió (o ya
    // falló) y ese resultado es más importante que su bitácora.
    console.error(`[upload] could not write load_log: ${error.message}`);
    return null;
  }
  return (data as { id: number } | null)?.id ?? null;
}

/**
 * Guarda en `load_log` cómo terminó el sync que disparó esta carga.
 *
 * ⚠ POR QUÉ CON service_role Y NO CON LA SESIÓN DEL USUARIO. Dos razones, y
 * cualquiera de las dos alcanza:
 *
 *  1. `load_log` no tiene política de UPDATE para `authenticated` -- sólo
 *     INSERT y SELECT. Con la sesión, este update afectaría CERO filas y no
 *     devolvería error: RLS filtra, no rechaza. Sería exactamente el fallo
 *     silencioso que esta función viene a eliminar. Y agregar esa política le
 *     daría a la usuaria permiso para reescribir su propia bitácora, que es
 *     justo lo que no se quiere de una bitácora.
 *  2. Esto corre dentro de `after()`, con la respuesta ya enviada. Depender de
 *     leer la cookie de sesión en ese momento es frágil; el service_role no
 *     depende de nadie.
 *
 * Nunca lanza: llega después de que la carga ya se reportó y no hay a quién
 * avisarle salvo el log del servidor.
 */
async function recordSyncOutcome(logId: number, result: SyncTrigger): Promise<void> {
  try {
    const { error } = await getAdminUploadsClient('uploads')
      .from('load_log')
      .update({
        sync_status: result.ok ? 'ok' : 'error',
        sync_error: result.ok ? null : result.error,
        sync_finished_at: new Date().toISOString(),
      })
      .eq('id', logId);

    if (error) {
      console.error(`[upload] could not record sync outcome on load_log ${logId}: ${error.message}`);
    }
  } catch (err) {
    console.error(
      `[upload] could not record sync outcome on load_log ${logId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ source: string }> }) {
  const started = Date.now();
  const { source: sourceKey } = await ctx.params;

  // ---- 1 y 2. Sesión, acceso a la app, fuente asignada y su configuración
  // Los cuatro pasos viven en `lib/uploads/authorizeSource.ts` porque el previo
  // de columnas los necesita idénticos: si leyera otra fila de `uploads.source`
  // mostraría columnas que la carga no va a usar.
  const auth = await authorizeSource(sourceKey);
  if (!auth.ok) return auth.response;

  const { userEmail, sb, sourceRow, rules } = auth.ctx;

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

  // ---- 5a. Filtrar por división ----------------------------------------
  /*
   * DESPUÉS DE VALIDAR Y ANTES DE ESCRIBIR. El orden no es libre: la validación
   * responde "¿llegó el archivo entero?", así que mira las 1.405 filas. Si
   * midiera después del filtro, un archivo truncado que casualmente trajera sólo
   * nuestros branches pasaría como bueno.
   */
  let filtered: DivisionFilterResult | null = null;

  if (rules.divisionFilter) {
    const rule = rules.divisionFilter;

    if (!hasBranchColumn(parsed, rule)) {
      const message =
        `the division filter needs column "${rule.branchColumn}", which is not in the file; ` +
        `columns found: ${parsed.headers.join(', ')}`;
      await writeLog(sb, {
        source_key: sourceKey,
        user_email: userEmail,
        file_name: fileName,
        rows_loaded: null,
        status: 'validation_failed',
        error_message: message,
      });
      return Response.json(
        { ok: false, stage: 'division_filter', error: message },
        { status: 422 },
      );
    }

    const { data: decisions, error: decisionsError } = await sb
      .from('branch_division_decision')
      .select('branch_code, in_division');

    /*
     * ⚠ ACÁ SE ABORTA, Y ES LA GUARDA MÁS IMPORTANTE DE ESTA RUTA.
     *
     * Sin decisiones, los 24 branches que empiezan con 7 caen todos en "sin
     * decidir" y entrarían -- incluidos los 9 que ya se decidieron ajenos. Un
     * problema de permisos se convertiría en una fuga.
     *
     * Y la lista vacía es tan sospechosa como el error: con RLS, una tabla sin
     * política devuelve CERO FILAS y `error: null`, indistinguible de una tabla
     * vacía. Por eso los dos casos abortan, y el mensaje dice que el problema
     * son las decisiones y no el archivo: quien lo lea tiene que ir a mirar
     * permisos, no a revisar el Excel.
     */
    if (decisionsError) {
      const message =
        `could not read uploads.branch_division_decision (${decisionsError.message}); ` +
        'refusing to load: without the decisions every 7xx branch would look undecided ' +
        'and people from other divisions would be written. This is a permissions or ' +
        'connectivity problem, not a problem with the file.';
      console.error(`[upload] ${sourceKey}: ${message}`);
      await writeLog(sb, {
        source_key: sourceKey,
        user_email: userEmail,
        file_name: fileName,
        rows_loaded: null,
        status: 'error',
        error_message: message,
      });
      return Response.json({ ok: false, stage: 'division_filter', error: message }, { status: 503 });
    }

    if (!decisions || decisions.length === 0) {
      const message =
        'uploads.branch_division_decision came back empty; refusing to load. With RLS a ' +
        'table without a policy returns zero rows and no error, so this is most likely a ' +
        'permissions problem rather than an empty table. Without the decisions every 7xx ' +
        'branch would look undecided and people from other divisions would be written.';
      console.error(`[upload] ${sourceKey}: ${message}`);
      await writeLog(sb, {
        source_key: sourceKey,
        user_email: userEmail,
        file_name: fileName,
        rows_loaded: null,
        status: 'error',
        error_message: message,
      });
      return Response.json({ ok: false, stage: 'division_filter', error: message }, { status: 503 });
    }

    filtered = filterByDivision(parsed, rule, decisions as DivisionDecision[]);

    /*
     * Cero filas después de filtrar no es "no había nadie de la división": el
     * archivo pasó la validación de filas, así que traía gente. Es el archivo
     * equivocado, o la columna del branch trae otra cosa. Cargar cero filas en
     * modo append no rompe nada, pero deja una carga vacía que después nadie
     * entiende.
     */
    if (filtered.parsed.rows.length === 0) {
      const message =
        `every row was filtered out: ${filtered.summary.otra_division} from other ` +
        `divisions, ${filtered.summary.descartado} explicitly excluded, ` +
        `${filtered.summary.sin_branch} with no branch code`;
      await writeLog(sb, {
        source_key: sourceKey,
        user_email: userEmail,
        file_name: fileName,
        rows_loaded: 0,
        status: 'validation_failed',
        error_message: message,
      });
      return Response.json(
        { ok: false, stage: 'division_filter', error: message, detalle: filtered.summary },
        { status: 422 },
      );
    }

    parsed = filtered.parsed;

    console.log(
      `[upload] ${sourceKey}: division filter kept ${parsed.rows.length}, ` +
        `dropped ${filtered.summary.otra_division}+${filtered.summary.descartado}+` +
        `${filtered.summary.sin_branch}, pending ${filtered.pending.length}`,
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

    // El id de ESTA fila es lo que después completa `recordSyncOutcome`.
    const logId = await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: rowsInTable,
      // Se guardan aunque la carga haya salido bien: un branch sin decidir es
      // exactamente el caso en que la carga funciona y aun así hay algo que
      // hacer. Si quedara sólo en la respuesta, se iría con el navegador.
      division_filtered: filtered?.summary ?? null,
      division_pending: filtered?.pending ?? null,
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
     * Y se corre igual una carrera contra SYNC_CONFIRM_MS para poder decir algo
     * en la respuesta. Pero esa carrera casi nunca la gana el sync: tarda ~31
     * segundos y la espera es de 5, así que la tarjeta dice "actualizando" y
     * después nadie vuelve a enterarse.
     *
     * POR ESO EL RESULTADO SE GUARDA EN `load_log`, y no sólo se reporta. Que un
     * sync fallido no haga fallar la carga es correcto -- el archivo ya está en
     * BigQuery -- pero "no falla la carga" no puede significar "nadie se entera".
     * El 31 de agosto un sync falló a las 14:08, volvió a fallar a las 14:11, y
     * el error vivió tres horas sólo en el log de Vercel mientras alguien subía
     * el archivo creyendo que el dato se refrescaba. Con esto, el historial de
     * la tarjeta lo muestra la próxima vez que alguien la abre.
     *
     * Alargar la espera no es la solución: 31 segundos parado frente a una carga
     * que ya terminó es peor que enterarse después.
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
        const running = triggerSync(req.nextUrl.origin, secret).then(async (result) => {
          if (!result.ok) {
            console.error(`[upload] sync after ${sourceKey} failed: ${result.error}`);
          } else {
            console.log(`[upload] sync after ${sourceKey} completed`);
          }
          // El log del servidor sirve para investigar; la fila de `load_log` es
          // lo que ve la usuaria sin salir de la app. Se escriben las dos.
          if (logId !== null) await recordSyncOutcome(logId, result);
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
        // Sólo para las fuentes con filtro de división; null en las demás.
        filtro_division: filtered?.summary ?? null,
        branches_pendientes: filtered?.pending ?? null,
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
