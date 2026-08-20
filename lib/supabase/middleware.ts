import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * CLIENTE DE SUPABASE PARA EL GATE (proxy.ts)
 *
 * Es el único punto de la app que ESCRIBE cookies de sesión. Cuando el access
 * token está por vencer, `supabase.auth.getUser()` lo renueva y devuelve
 * cookies nuevas; si no se copian a la respuesta que sale, la sesión se cae
 * sola a los pocos minutos y el usuario vuelve al login sin motivo aparente.
 */

export function createMiddlewareClient(request: NextRequest) {
  // Acumula lo que Supabase quiera escribir durante getUser().
  let cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(newCookies) {
          cookiesToSet = newCookies;
          // También en la request: si algo más adelante en este mismo ciclo
          // vuelve a leer la cookie, tiene que ver el valor renovado.
          for (const { name, value } of newCookies) {
            request.cookies.set(name, value);
          }
        },
      },
    }
  );

  /** Respuesta "seguir adelante", con las cookies renovadas. */
  function response(): NextResponse {
    const res = NextResponse.next({ request });
    for (const { name, value, options } of cookiesToSet) {
      res.cookies.set(name, value, options);
    }
    return res;
  }

  return { supabase, response };
}

/**
 * Copia las cookies de sesión de una respuesta a otra.
 *
 * Un `NextResponse.redirect()` se crea desde cero: no hereda nada de la
 * respuesta que veníamos armando. Sin este paso, cualquier renovación de token
 * ocurrida durante el chequeo se pierde justo en las rutas que más redirigen.
 */
export function withAuthCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}
