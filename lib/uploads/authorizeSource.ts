import type { User } from '@supabase/supabase-js';
import { getSessionUser } from '@/lib/auth/session';
import { hasAppAccess } from '@/lib/auth/appAccess';
import { getServerClient } from '@/lib/supabase/server';
import { getSourceRules, type SourceRules } from './sources';

/**
 * ============================================================================
 * QUIÉN PUEDE TOCAR ESTA FUENTE, Y CÓMO ESTÁ CONFIGURADA
 * ============================================================================
 *
 * Los tres primeros pasos de la carga --sesión, acceso a la app, la fuente
 * asignada a ESTE usuario-- más la fila de `uploads.source`.
 *
 * Vive acá y no en la ruta porque hay DOS rutas que lo necesitan: la carga
 * (`/api/upload/[source]`) y el previo de columnas
 * (`/api/upload/[source]/preview`).
 *
 * ⚠ POR QUÉ COMPARTIDO Y NO COPIADO. El previo existe para mostrar de antemano
 * las columnas que va a usar la carga. Si leyera la fuente por su cuenta --otra
 * consulta, otro `is_active`, otro `header_row`-- podría mostrar columnas de una
 * configuración distinta de la que después se aplica. Un previo que miente es
 * peor que no tener previo: hoy quien sube el archivo al menos sabe que no sabe.
 * Compartiendo esta función, las dos rutas leen literalmente la misma fila.
 *
 * Devuelve el error como `Response` ya armada en vez de lanzar: los códigos y
 * los mensajes son parte del contrato de las rutas --401, 403, 404, 500 con
 * significados distintos-- y traducirlos de una excepción a un status en cada
 * ruta es la clase de cosa que se desincroniza.
 */

export type SourceConfig = {
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

/** Cliente de Supabase con la sesión del usuario, sobre el esquema `uploads`. */
export type UploadsClient = Awaited<ReturnType<typeof getServerClient>>;

export type SourceContext = {
  user: User;
  userEmail: string;
  sb: UploadsClient;
  sourceRow: SourceConfig;
  rules: SourceRules;
};

export type AuthorizeResult =
  | { ok: true; ctx: SourceContext }
  | { ok: false; response: Response };

export async function authorizeSource(sourceKey: string): Promise<AuthorizeResult> {
  // ---- Sesión y acceso a la app ----------------------------------------
  // El gate (proxy.ts) ya cubre esto, pero se repite acá: son las rutas que
  // leen y escriben datos, y no deben depender de que el matcher del gate siga
  // cubriéndolas.
  let user: User | null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }

  if (!user) {
    return { ok: false, response: Response.json({ ok: false, error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!hasAppAccess(user)) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'No access to this application' }, { status: 403 }),
    };
  }

  const userEmail = user.email;
  if (!userEmail) {
    return { ok: false, response: Response.json({ ok: false, error: 'Session has no email' }, { status: 403 }) };
  }

  const sb = await getServerClient('uploads');

  // ---- Esta fuente está asignada a ESTE usuario ------------------------
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
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: `could not verify assignment: ${assignmentError.message}` },
        { status: 500 },
      ),
    };
  }
  if (!assignment) {
    // 403 y no 404: existir o no la fuente no es asunto de quien no la tiene.
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: `not authorized for source "${sourceKey}"` },
        { status: 403 },
      ),
    };
  }

  // ---- Configuración de la fuente --------------------------------------
  const { data: sourceRow, error: sourceError } = await sb
    .from('source')
    .select('*')
    .eq('source_key', sourceKey)
    .eq('is_active', true)
    .maybeSingle<SourceConfig>();

  if (sourceError) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: `could not read source config: ${sourceError.message}` },
        { status: 500 },
      ),
    };
  }
  if (!sourceRow) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: `source "${sourceKey}" is not configured or not active` },
        { status: 404 },
      ),
    };
  }

  return {
    ok: true,
    ctx: { user, userEmail, sb, sourceRow, rules: getSourceRules(sourceKey) },
  };
}

/**
 * La fila del encabezado según la configuración, o `null` si está mal puesta.
 *
 * Compartida por las dos rutas a propósito: si el previo leyera el encabezado de
 * una fila y la carga de otra, el previo mostraría columnas que la carga no va a
 * usar. Es el mismo motivo por el que `authorizeSource` es compartida.
 */
export function resolveHeaderRow(sourceRow: SourceConfig): number | null {
  const headerRow = sourceRow.header_row ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1) return null;
  return headerRow;
}
