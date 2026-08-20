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
import type { NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { getSessionUser } from '@/lib/auth/session';
import { hasAppAccess } from '@/lib/auth/appAccess';
import { getServerClient } from '@/lib/supabase/server';
import { getBigQueryWriterClient, assertWritableDataset } from '@/lib/bigquery-writer';
import { getSourceRules, type SourceRules } from '@/lib/uploads/sources';
import { parseXlsx, parseCsv, type ParsedFile } from '@/lib/uploads/parse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Parsear ~5,000 filas y esperar el load job de BigQuery no entra en el default.
export const maxDuration = 300;

type SourceConfig = {
  source_key: string;
  display_name: string;
  target_dataset: string;
  target_table: string;
  load_mode: string;
  min_rows_expected: number;
  sheet_name: string | null;
  is_active: boolean;
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

  let rules: SourceRules;
  try {
    rules = getSourceRules(sourceKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
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
    if (isXlsx) {
      parsed = await parseXlsx(await file.arrayBuffer(), sourceRow.sheet_name, rules.requireNonEmpty);
    } else {
      parsed = parseCsv(await file.text(), rules.requireNonEmpty);
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

  const present = new Set(parsed.rawHeaders.map((h) => h.trim().toLowerCase()));
  const missing = rules.requiredColumns.filter((c) => !present.has(c.trim().toLowerCase()));
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

  // ---- 6-8. Cargar, verificar, registrar -------------------------------
  try {
    assertWritableDataset(sourceRow.target_dataset);

    if (sourceRow.load_mode !== 'replace') {
      throw new Error(`unsupported load_mode "${sourceRow.load_mode}"; only "replace" is implemented`);
    }

    const bq = getBigQueryWriterClient();
    const table = bq.dataset(sourceRow.target_dataset).table(sourceRow.target_table);

    // Todo STRING: es una tabla de staging y el casteo vive en las vistas de
    // lending_marts. Con autodetect, una columna que un día viene vacía y otro
    // trae texto cambiaría de tipo sola y rompería las vistas de golpe.
    const schema = { fields: parsed.headers.map((name) => ({ name, type: 'STRING' })) };

    const ndjson = parsed.rows.map((r) => JSON.stringify(r)).join('\n');

    await new Promise<void>((resolve, reject) => {
      const stream = table.createWriteStream({
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
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
    const fq = `\`${bq.projectId}.${sourceRow.target_dataset}.${sourceRow.target_table}\``;
    const [countRows] = await bq.query({ query: `SELECT COUNT(*) AS n FROM ${fq}` });
    const rowsInTable = Number(countRows?.[0]?.n ?? 0);
    const matches = rowsInTable === parsed.rows.length;

    await writeLog(sb, {
      source_key: sourceKey,
      user_email: userEmail,
      file_name: fileName,
      rows_loaded: rowsInTable,
      status: matches ? 'ok' : 'error',
      error_message: matches
        ? null
        : `row count mismatch: parsed ${parsed.rows.length}, table has ${rowsInTable}`,
    });

    return Response.json(
      {
        ok: matches,
        fuente: sourceRow.display_name,
        archivo: fileName,
        destino: `${sourceRow.target_dataset}.${sourceRow.target_table}`,
        filas_parseadas: parsed.rows.length,
        filas_en_tabla: rowsInTable,
        filas_descartadas: parsed.discardedRows,
        columnas: parsed.headers.length,
        columnas_esperadas: rules.expectedColumnCount ?? null,
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
