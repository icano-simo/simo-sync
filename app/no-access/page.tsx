'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@/lib/supabase/client';
import { LOGIN_PATH } from '@/lib/auth/routes';
import '@/app/styles/app.css';

/**
 * SIN ACCESO — sesión válida, pero sin `data_uploads` en allowed_apps.
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
      <div className="auth-card">
        <h1>No tenés acceso a Cargas de archivos</h1>
        <p>
          Tu sesión es válida{email ? ` (${email})` : ''}, pero esta cuenta no está autorizada para
          abrir este módulo.
        </p>
        <p>
          Pedile acceso al administrador de simoOS. Tu sesión sigue activa para las demás
          aplicaciones del portal.
        </p>
        <button onClick={signOut} disabled={busy}>
          {busy ? 'Cerrando sesión…' : 'Cerrar sesión'}
        </button>
      </div>
    </main>
  );
}
