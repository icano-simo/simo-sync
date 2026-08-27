import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getAuthAdminClient, isAuthAdminConfigured } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ============================================================================
 * LIBERAR `must_change_password` DESPUÉS DE UN CAMBIO REAL
 * ============================================================================
 *
 * Port de `app/api/auth/complete-password-change/route.ts` de
 * homesi-reporte-actividad. Único cambio: el cliente sale de
 * `lib/supabase-admin.ts` en vez de `lib/supabase/admin.ts` -- ver el comentario
 * de ese archivo sobre por qué no se crea el segundo módulo.
 *
 * El flag vive en `app_metadata` justamente para que el navegador NO pueda
 * escribirlo: si viviera en `user_metadata`, cualquiera se lo bajaría solo y se
 * saltearía el cambio. La contrapartida es que liberarlo tiene que pasar por
 * acá, con service_role. El cliente cambia la contraseña por su cuenta con
 * `auth.updateUser()` y después llama a esta ruta para abrir la puerta.
 *
 * EL USUARIO SALE DE LA COOKIE DE SESIÓN, NUNCA DEL BODY. Si viniera del body,
 * cualquiera con sesión podría limpiarle el flag a otra cuenta.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Chequeo explícito antes de construir el cliente: sin service_role el
  // mensaje tiene que decir qué falta, y no un error genérico de Supabase.
  if (!isAuthAdminConfigured()) {
    return NextResponse.json(
      { error: 'Server is missing SUPABASE_SERVICE_ROLE; cannot unlock the account.' },
      { status: 503 },
    );
  }

  const admin = getAuthAdminClient();

  // Se relee del servidor en vez de confiar en el app_metadata que venía en el
  // token del cliente: ese token puede ser viejo, y escribir a partir de él
  // pisaría cualquier claim que haya cambiado mientras tanto.
  const { data: fetched, error: fetchError } = await admin.auth.admin.getUserById(user.id);
  if (fetchError || !fetched?.user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  /*
   * Se conserva el resto de app_metadata (`allowed_apps`, sobre todo -- perderlo
   * dejaría a la persona sin acceso a la app justo después de cambiar la
   * contraseña) pero SIN `provider` ni `providers`: son claims reservados que
   * administra GoTrue, y reenviarlos en una escritura es una causa conocida de
   * que la actualización se descarte en silencio.
   */
  const safeMetadata = { ...(fetched.user.app_metadata ?? {}) };
  delete safeMetadata.provider;
  delete safeMetadata.providers;

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...safeMetadata,
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  /*
   * Se verifica releyendo, no confiando en que la API no devolvió error. Si el
   * flag siguiera puesto, la persona quedaría en un bucle silencioso: cambia la
   * contraseña, el gate la devuelve a /change-password, y no hay forma de saber
   * por qué. Mejor un error explícito y que reintente.
   */
  const { data: check } = await admin.auth.admin.getUserById(user.id);
  if (check?.user?.app_metadata?.must_change_password === true) {
    return NextResponse.json(
      { error: 'The password was changed but the account could not be unlocked. Try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
