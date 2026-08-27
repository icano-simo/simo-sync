import type { User } from '@supabase/supabase-js';

/**
 * ACCESO A ESTA APP DENTRO DEL PROYECTO COMPARTIDO
 *
 * Mismo patrón que icano-simo/homesi-reporte-actividad (lib/auth/appAccess.ts).
 * El proyecto de Supabase (simoOS-prod) es compartido con las otras apps del
 * portal, así que una sesión válida sólo prueba que la persona trabaja acá --
 * no que pueda abrir ESTA app. El permiso se otorga por aplicación.
 *
 * Vive en `app_metadata` y no en `user_metadata` a propósito: `user_metadata`
 * es escribible desde el navegador por el propio usuario, así que cualquiera
 * podría agregarse el permiso solo. `app_metadata` sólo lo escribe el
 * service_role.
 *
 * NOTA: esto es la comprobación de la UI, para poder mandar a la persona a
 * /no-access en vez de a una pantalla rota. Lo que de verdad protege los datos
 * son las políticas de RLS del esquema `uploads`, más el chequeo por fuente de
 * la ruta de subida -- que no confía en que la UI haya ocultado nada.
 */

/** La entrada de esta app en `app_metadata.allowed_apps`. */
export const APP_NAME = 'data_uploads';

/** Forma mínima de usuario que necesita el chequeo -- sirve igual del lado del navegador y del servidor. */
type UserLike = Pick<User, 'app_metadata'> | null | undefined;

/**
 * true si el usuario tiene esta app entre las autorizadas.
 *
 * Se valida que `allowed_apps` sea un array antes de usarlo: si el claim no
 * existe todavía llega `undefined`, y un `.includes` sobre eso rompería la
 * página en vez de negar el acceso.
 */
export function hasAppAccess(user: UserLike): boolean {
  const allowedApps = user?.app_metadata?.allowed_apps;
  return Array.isArray(allowedApps) && allowedApps.includes(APP_NAME);
}
