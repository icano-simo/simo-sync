// Server-only Supabase client. SUPABASE_SERVICE_ROLE bypasses RLS, so this
// module must never be imported from a client component. `server-only` turns
// an accidental client import into a build error rather than a silent leak.
import 'server-only';
import { createClient } from '@supabase/supabase-js';

/** Target schema for every table this job writes. */
export const TARGET_SCHEMA = 'b2b_metrics';

function build(url: string, serviceRole: string) {
  return createClient(url, serviceRole, {
    db: { schema: TARGET_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client bound to the b2b_metrics schema, not the default `public`. */
export type MetricsClient = ReturnType<typeof build>;

let cached: MetricsClient | null = null;

export function getSupabaseClient(): MetricsClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRole) {
    // Names only -- never the value.
    const missing = [
      !url && 'SUPABASE_URL',
      !serviceRole && 'SUPABASE_SERVICE_ROLE',
    ].filter(Boolean);
    throw new Error(`Missing Supabase env vars: ${missing.join(', ')}`);
  }

  cached = build(url, serviceRole);
  return cached;
}

/**
 * ============================================================================
 * CLIENTE DE LA ADMIN API DE AUTH (service_role)
 * ============================================================================
 *
 * Para liberar `must_change_password`, que vive en `app_metadata`. Ese claim es
 * deliberadamente NO escribible por el navegador -- si viviera en
 * `user_metadata` cualquiera se lo bajaría solo y se saltearía el cambio de
 * contraseña. La contrapartida es que bajarlo requiere service_role.
 *
 * POR QUÉ ESTÁ ACÁ Y NO EN `lib/supabase/admin.ts`, QUE ES EL NOMBRE QUE USA EL
 * REPO DE REFERENCIA: crear `lib/supabase/admin.ts` al lado de este archivo
 * reconstruiría exactamente la colisión que ya arreglamos una vez -- dos
 * clientes de service_role resolviendo desde rutas de import casi idénticas.
 * Este módulo ya es "el lugar donde vive el service_role"; el cliente de auth
 * es un segundo export suyo, no un archivo nuevo.
 *
 * UNA SOLA VARIABLE PARA LA LLAVE: se reusa `SUPABASE_SERVICE_ROLE`, la misma
 * que ya usa el job de sync arriba y que ya está configurada en Vercel. El repo
 * de referencia la llama `SUPABASE_SERVICE_ROLE_KEY`, pero duplicar el valor en
 * dos variables sería una trampa para la próxima rotación de llave: actualizar
 * una sola y olvidar la otra no rompe el build ni tira ningún error -- deja la
 * mitad de la app hablando con una credencial vencida. Un solo nombre, un solo
 * lugar donde rotarla.
 *
 * Esto es válido porque el proyecto de Supabase es UNO SOLO (simoOS-prod,
 * eykplgdwlqpybzkzbpmu): la sesión, el esquema `uploads` y el destino del sync
 * viven todos ahí. Si algún día el sync apuntara a otro proyecto, esto se
 * rompe en silencio -- escribiría en el proyecto equivocado -- y habría que
 * volver a separar las llaves.
 *
 * La URL, en cambio, sí sale de `NEXT_PUBLIC_SUPABASE_URL` y no de
 * `SUPABASE_URL`: tiene que ser el proyecto del que salió la sesión o
 * `getUserById` no encontraría al usuario, y es la que usa el resto del flujo
 * de auth (`lib/supabase/server.ts`, `lib/supabase/client.ts`).
 *
 * REGLAS DE USO, sin excepción:
 *   1. Sólo desde Route Handlers. Este módulo importa `server-only`, así que un
 *      import desde un componente de cliente rompe el build en vez de filtrar
 *      la llave al bundle.
 *   2. Quien llama se resuelve SIEMPRE desde la cookie de sesión
 *      (`getSessionUser()`), nunca desde el body. Este cliente no tiene noción
 *      de "quién está llamando", así que preguntárselo a él sería el error.
 */

const MISSING_AUTH_ADMIN_MESSAGE =
  'Missing Supabase auth admin env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE. ' +
  'The password-change route cannot clear the flag without them.';

/**
 * Cliente con service_role para la Admin API de `auth`.
 *
 * Sin `db.schema`: lo único que se usa es `auth.admin`, que no pasa por
 * PostgREST y no depende de ningún schema de datos.
 */
export function getAuthAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRoleKey) {
    throw new Error(MISSING_AUTH_ADMIN_MESSAGE);
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** true si el service_role de auth está configurado -- para diagnosticar sin lanzar. */
export function isAuthAdminConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE);
}
