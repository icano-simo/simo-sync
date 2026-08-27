'use client';

import { usePathname } from 'next/navigation';
import BrandLockup from './HomesiLogo';
import UserMenu from './UserMenu';
import { isAuthRoute } from '@/lib/auth/routes';

/*
 * ============================================================================
 * HEADER — barra superior, mismo shell que el resto del portal
 * ============================================================================
 *
 * Port de `components/layout/ServiceHubHeader.tsx` de homesi-reporte-actividad.
 * Consume las MISMAS clases (`.hub-header`, `.hub-header__inner`,
 * `.hub-brand__logo`) de `app/styles/shell.css`, copiado tal cual, así que la
 * barra mide y se ve igual en las dos apps.
 *
 * NO ES UN SIDEBAR: el rail vertical se eliminó en esa app a propósito y acá
 * nunca existió.
 *
 * DIFERENCIA con el original: no lleva `.hub-nav` con tabs de módulo. Allá los
 * tabs navegan entre tres módulos; esta app tiene una sola vista, y un tab
 * único que apunta a la página en la que ya estás es decoración que hay que
 * mantener. Cuando haya una segunda vista, los tabs se portan de allá.
 *
 * Se monta una sola vez en app/layout.tsx, así que es idéntico en toda la app.
 */

/** Título de módulo del header. Constante nombrada para no repetir el string. */
const MODULE_TITLE = 'Data Uploads';

export default function AppHeader() {
  const pathname = usePathname();

  /*
   * /login y /no-access no llevan el shell: mostrarle la barra de la app a
   * alguien que todavía no entró no tiene sentido, y en /no-access el botón de
   * cerrar sesión ya está en la tarjeta.
   *
   * Se resuelve acá y no con un route group para no cambiar la ruta de archivo
   * de dos páginas que ya existen por un condicional de una línea.
   */
  if (isAuthRoute(pathname)) return null;

  return (
    <header className="hub-header">
      <div className="hub-header__inner">
        <div className="hub-brand">
          <BrandLockup />
          <span className="hub-brand__divider" aria-hidden="true" />
          <span className="hub-brand__module">{MODULE_TITLE}</span>
        </div>

        <UserMenu />
      </div>
    </header>
  );
}
