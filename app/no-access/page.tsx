'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@/lib/supabase/client';
import { LOGIN_PATH } from '@/lib/auth/routes';
import { AlertTriangleIcon } from '@/components/ui/icons';
import '@/app/styles/auth.css';

/**
 * ============================================================================
 * SIN ACCESO — sesión válida, pero sin permiso sobre esta app
 * ============================================================================
 *
 * Página propia en vez de un redirect de vuelta a /login: los dos estados NO
 * son el mismo. El gate saca de /login a cualquiera con sesión válida, así que
 * rebotar ahí a alguien sin permiso produce un bucle de redirecciones hasta que
 * el navegador corta. Además, decir qué pasó y a quién pedirle acceso es más
 * útil que fingir que el login falló.
 *
 * La sesión se deja INTACTA: es compartida con las otras apps del portal (mismo
 * proyecto de Supabase), así que cerrarla acá también sacaría a la persona de
 * ésas. El botón existe, pero es una decisión suya y no un efecto secundario de
 * haber entrado a la app equivocada.
 *
 * Markup y estilo portados de homesi-reporte-actividad; cambia sólo el nombre
 * del módulo en el título.
 */
export default function NoAccessPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSupabaseClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setEmail(data.user?.email ?? null);
      })
      // Sin sesión o con Supabase caído no hay email que mostrar; el texto ya
      // funciona sin él, así que no se agrega ningún error extra.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    setBusy(true);
    await getSupabaseClient().auth.signOut();
    router.replace(LOGIN_PATH);
    router.refresh();
  }

  return (
    <main className="auth-screen">
      <div className="auth-panel">
        <Image
          className="auth-logo"
          src="/brand/homesi-lockup.png"
          alt="HOMESÍ — Powered by Supreme Lending"
          width={320}
          height={55}
          priority
        />

        <div className="auth-card">
          <div className="auth-icon">
            <span>
              <AlertTriangleIcon size={22} />
            </span>
          </div>

          <h1 className="auth-title">You don&apos;t have access to Data Uploads</h1>

          <p className="auth-text">
            Your session is valid{email ? ` (${email})` : ''}, but this account is not authorized to
            open this module.
          </p>

          <p className="auth-note">
            Ask the Homesí administrator for access. Your session stays active for the other portal
            applications.
          </p>

          <button onClick={signOut} disabled={busy} className="auth-secondary">
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </main>
  );
}
