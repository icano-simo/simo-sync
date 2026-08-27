import type { User } from '@supabase/supabase-js';
import { getServerClient } from '@/lib/supabase/server';

/**
 * QUIÉN ESTÁ LLAMANDO — verificación de sesión para Route Handlers
 *
 * El gate (`proxy.ts`) ya rechaza las llamadas sin sesión a `/api/*`, así que
 * esto es defensa en profundidad y no el único candado: un cambio futuro en el
 * `matcher`, o una ruta alcanzada por un path que el matcher no cubra, dejaría
 * abierto un endpoint que escribe en BigQuery. La ruta de subida llama a esto
 * primero, siempre.
 */

/** El usuario autenticado, o null. Validado contra Supabase, no sólo decodificado. */
export async function getSessionUser(): Promise<User | null> {
  try {
    const supabase = await getServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user ?? null;
  } catch {
    // Falta de configuración o Supabase caído se trata como "no hay sesión".
    // Es la dirección segura en la que fallar.
    return null;
  }
}
