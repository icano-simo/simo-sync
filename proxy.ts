import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareClient, withAuthCookies } from '@/lib/supabase/middleware';
import { hasAppAccess } from '@/lib/auth/appAccess';
import {
  LOGIN_PATH,
  NO_ACCESS_PATH,
  CHANGE_PASSWORD_PATH,
  DEFAULT_LANDING,
  PASSWORD_CHANGE_ROUTES,
  matchesRoute,
} from '@/lib/auth/routes';

/**
 * GATE DE AUTENTICACIÓN
 *
 * Mismo patrón que `proxy.ts` de icano-simo/homesi-reporte-actividad.
 *
 * Va acá y no en el layout raíz porque:
 *  1. Toda ruta pasa por acá, así que las páginas quedan protegidas POR
 *     EXISTIR. Agregar una vista nueva no requiere acordarse de nada.
 *  2. Corre ANTES de renderizar: un gate en el layout es un componente de
 *     cliente, o sea un parpadeo de contenido para quien no debería verlo.
 *  3. Es el único punto donde se puede refrescar el token, que necesita
 *     escribir cookies en la respuesta.
 *
 * Se llama `proxy.ts` y no `middleware.ts` porque Next 16 renombró la
 * convención. Mismo punto de ejecución, misma semántica.
 *
 * IMPORTANTE -- `/api/sync` queda FUERA del matcher. Es un cron sin sesión que
 * se autentica con CRON_SECRET; pasarlo por este gate lo rompería con un 401
 * todas las noches.
 *
 * El chequeo de `must_change_password` va DESPUÉS del de sesión y del de
 * `allowed_apps`, no antes. El orden es deliberado: obligar a alguien a elegir
 * una contraseña nueva para una app que después no va a poder abrir es trabajo
 * inútil, y le diría además que la app existe.
 */

/** Alcanzable sin sesión. Todo lo demás la exige. */
const PUBLIC_ROUTES = [LOGIN_PATH];

/** Alcanzable con sesión pero sin acceso. Exenta, o el redirect se persigue a sí mismo. */
const NO_ACCESS_ROUTES = [NO_ACCESS_PATH];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * Sin credenciales de Supabase no hay forma de verificar una sesión, así que
   * el gate cierra (fail closed) y manda al login, que muestra el mensaje real
   * de configuración faltante. Sin este guard, `createServerClient` recibiría
   * undefined como URL y cada request terminaría en 500.
   */
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    if (matchesRoute(pathname, PUBLIC_ROUTES)) return NextResponse.next();
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 });
    }
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = '';
    return NextResponse.redirect(url);
  }

  const { supabase, response } = createMiddlewareClient(request);

  // getUser, no getSession: getSession confía en la cookie tal cual viene,
  // mientras que getUser la valida contra Supabase. Un gate que confía en una
  // cookie sin verificar no es un gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isApi = pathname.startsWith('/api/');
  const isPublic = matchesRoute(pathname, PUBLIC_ROUTES);
  const isNoAccess = matchesRoute(pathname, NO_ACCESS_ROUTES);
  const isPasswordChange = matchesRoute(pathname, PASSWORD_CHANGE_ROUTES);

  // -- Sin sesión --------------------------------------------------------
  if (!user) {
    if (isPublic) return response();

    // Las llamadas de API reciben 401 y no un redirect: un fetch que recibe el
    // HTML del login falla de forma confusa, casi siempre como un error de
    // parseo de JSON lejos de la causa real.
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
      );
    }

    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // -- Con sesión: tiene permiso sobre ESTA app? -------------------------
  if (!hasAppAccess(user) && !isNoAccess) {
    // 403, no 401: la persona ya probó quién es, lo que le falta es el permiso.
    // Un 401 sugeriría que volver a entrar ayudaría, y no ayuda.
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: 'No access to this application' }, { status: 403 }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = NO_ACCESS_PATH;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // -- Con sesión y acceso, pero todavía con contraseña temporal ---------
  // El flag vive en app_metadata, que sólo escribe el service_role, así que no
  // se puede bajar desde el navegador para saltearse el cambio.
  //
  // `isPasswordChange` cubre la página Y la API route que libera el flag: sin
  // esa exención, /change-password se redirigiría a sí misma en bucle y la
  // llamada que la desbloquea nunca podría salir, dejando a la persona
  // encerrada de forma permanente.
  const mustChangePassword = user.app_metadata?.must_change_password === true;

  if (mustChangePassword && !isPasswordChange) {
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: 'Password change required' }, { status: 403 }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = CHANGE_PASSWORD_PATH;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // Quien ya NO debe cambiar la contraseña no tiene nada que hacer en esa
  // página -- si no, quedaría accesible para siempre desde el historial.
  if (!mustChangePassword && matchesRoute(pathname, [CHANGE_PASSWORD_PATH])) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_LANDING;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // Quien SÍ tiene acceso no debería quedarse en /no-access.
  if (hasAppAccess(user) && isNoAccess) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_LANDING;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // Ya autenticado y con acceso: /login no tiene nada que ofrecerle.
  if (isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_LANDING;
    url.search = '';
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  return response();
}

export const config = {
  /*
   * Se excluyen los assets estáticos y el favicon: no necesitan sesión y
   * hacerlos pasar por acá agrega una llamada a Supabase por cada imagen.
   *
   * `icon.png` y `brand/` se agregan junto con los assets de marca: son el
   * ícono de la pestaña y el lockup del header, que el navegador pide en cada
   * carga. Sin excluirlos, cada pedido de una imagen agrega una llamada a
   * `getUser()` contra Supabase para nada.
   *
   * `api/sync` se excluye explícitamente: es el cron, se autentica con
   * CRON_SECRET y no tiene cookie de sesión. Si pasara por el gate, el gate lo
   * rechazaría con 401 antes de que la ruta pudiera validar su propio secreto.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|brand/|api/sync).*)'],
};
