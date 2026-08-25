/**
 * RUTAS DE AUTENTICACIÓN — fuente única
 *
 * Las consumen `proxy.ts` (decide a dónde redirigir), las páginas de login /
 * no-access / change-password (deciden a dónde entrar) y el header (decide si
 * dibujarse). Duplicadas, cambiar una y olvidar otra produce justo el bug que
 * este patrón evita: un bucle de redirecciones.
 */

export const LOGIN_PATH = '/login';
export const NO_ACCESS_PATH = '/no-access';
export const CHANGE_PASSWORD_PATH = '/change-password';
/** La ruta que libera el flag `must_change_password` (necesita service_role). */
export const COMPLETE_PASSWORD_CHANGE_PATH = '/api/auth/complete-password-change';

/** A dónde va una sesión válida y con acceso. */
export const DEFAULT_LANDING = '/uploads';

/**
 * Rutas del flujo de autenticación. No son parte de la app en sí, así que no
 * llevan su shell: mostrar navegación a alguien que todavía no entró no tiene
 * sentido, y en /no-access sería un botón a una vista que no puede abrir.
 */
export const AUTH_ROUTES: string[] = [LOGIN_PATH, NO_ACCESS_PATH, CHANGE_PASSWORD_PATH];

/**
 * Alcanzables por alguien que TIENE sesión y acceso, pero todavía debe cambiar
 * su contraseña temporal. Exentas del redirect a /change-password: sin esta
 * exención esa página se redirigiría a sí misma en bucle, y la API route que
 * libera el flag no podría llamarse nunca -- dejando a la persona encerrada de
 * forma permanente.
 */
export const PASSWORD_CHANGE_ROUTES: string[] = [
  CHANGE_PASSWORD_PATH,
  COMPLETE_PASSWORD_CHANGE_PATH,
];

/** Coincidencia exacta o de sub-ruta ('/login' también cubre '/login/algo'). */
export function matchesRoute(pathname: string, routes: string[]): boolean {
  return routes.some((route) => pathname === route || pathname.startsWith(route + '/'));
}

/**
 * ¿Es una ruta del flujo de autenticación?
 *
 * La consume el header (`components/layout/AppHeader.tsx`) para no dibujarse en
 * ninguna de ellas. Vive acá y no en el componente para que haya UNA sola lista
 * de rutas de auth: cuando se agregó /change-password, el header quedó cubierto
 * sin tocarlo.
 */
export function isAuthRoute(pathname: string): boolean {
  return matchesRoute(pathname, AUTH_ROUTES);
}
