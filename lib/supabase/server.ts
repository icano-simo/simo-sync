import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * CLIENTE DE SUPABASE DEL SERVIDOR (Server Components y Route Handlers)
 *
 * Convierte la cookie de sesión en un cliente que actúa COMO EL USUARIO QUE
 * HIZO LA LLAMADA: las mismas políticas de RLS que rigen en el navegador rigen
 * acá, sin service_role ni ningún permiso elevado. Es lo que hace que el
 * chequeo "¿este usuario tiene esta fuente asignada?" no dependa de que la UI
 * se haya portado bien.
 *
 * Igual que en el repo de referencia, no se usa el cliente de service_role para
 * responder "quién está llamando": ese evade RLS y no tiene noción de sesión,
 * que es exactamente por qué no puede contestar esa pregunta.
 */

const MISSING_ENV_MESSAGE =
  'Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing.';

/**
 * Cliente con la sesión de la request.
 *
 * `cookies()` es async en Next 16. Los Route Handlers no pueden escribir
 * cookies a través de este objeto, así que `setAll` queda como no-op: el
 * refresco del token lo hace el gate (`proxy.ts`), que sí puede escribir en la
 * respuesta. Sin ese no-op, `@supabase/ssr` avisa por consola en cada llamada.
 */
export async function getServerClient(schema?: 'uploads') {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(MISSING_ENV_MESSAGE);
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    // Sin schema cuando sólo interesa `auth`: pedirlo obligaría a elegir uno al azar.
    ...(schema ? { db: { schema } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        /* ver nota de arriba: el refresco de sesión lo maneja proxy.ts */
      },
    },
  });
}
