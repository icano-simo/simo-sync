import { createBrowserClient } from '@supabase/ssr';

/**
 * CLIENTE DE SUPABASE DEL NAVEGADOR
 *
 * `createBrowserClient` (@supabase/ssr) y no `createClient`: guarda la sesión
 * en COOKIES en vez de localStorage. Hace falta porque el gate (`proxy.ts`)
 * corre en el servidor y sólo ve cookies, y porque la ruta de subida
 * (`/api/upload/[source]`) es same-origin: la cookie llega sola en el fetch y
 * puede hablar con Supabase COMO EL USUARIO, sin service_role.
 *
 * OJO -- no confundir con `lib/supabase-admin.ts`, que es el cliente
 * de service_role del job de sync. Ese evade RLS y no tiene noción de "quién
 * está llamando"; éste es exactamente lo contrario.
 */

const MISSING_ENV_MESSAGE =
  'Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing.';

function createUploadsClient(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey, { db: { schema: 'uploads' } });
}

type BrowserClient = ReturnType<typeof createUploadsClient>;

let client: BrowserClient | null = null;

/**
 * Cliente del navegador, cacheado sobre el schema `uploads`.
 *
 * El chequeo de env vars corre al PRIMER USO, no al evaluar el módulo: hacerlo
 * arriba provoca un 500 con pantalla en blanco en cualquier entorno sin
 * `.env.local`, incluido el prerender de `next build`.
 */
export function getSupabaseClient(): BrowserClient {
  if (client) return client;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(MISSING_ENV_MESSAGE);
  }

  client = createUploadsClient(supabaseUrl, supabaseAnonKey);
  return client;
}
