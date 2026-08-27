'use client';

import { useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@/lib/supabase/client';
import { DEFAULT_LANDING, COMPLETE_PASSWORD_CHANGE_PATH } from '@/lib/auth/routes';
import '@/app/styles/auth.css';

/**
 * ============================================================================
 * CAMBIO OBLIGATORIO DE CONTRASEÑA
 * ============================================================================
 *
 * Port de `app/change-password/page.tsx` de homesi-reporte-actividad, sin
 * cambios de markup ni de estilo: usa las mismas clases de `auth.css`, que se
 * copió tal cual y ya traía `.auth-heading` y `.auth-subtitle` para esta
 * pantalla.
 *
 * Llega acá quien tiene sesión válida, acceso a esta app, y todavía
 * `must_change_password: true` en su `app_metadata` -- típicamente porque entró
 * con una contraseña temporal que le asignó un administrador.
 *
 * SON DOS PASOS, Y EL ORDEN IMPORTA:
 *   1. La contraseña la cambia la propia sesión del usuario
 *      (`auth.updateUser`). No hace falta ningún privilegio especial.
 *   2. El flag vive en `app_metadata`, que el navegador NO puede escribir, así
 *      que liberarlo pasa por nuestra API route con service_role.
 *
 * Si el paso 2 falla, la contraseña YA quedó cambiada y la persona sigue
 * bloqueada: puede reintentar y el paso 1 simplemente vuelve a aplicarse. Es la
 * dirección segura en la que fallar -- lo inverso (liberar el flag y que el
 * cambio no se aplique) dejaría a alguien adentro con la contraseña temporal.
 */

/** Mínimo local. Supabase impone el suyo aparte; el que sea más estricto gana. */
const MIN_LENGTH = 8;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const supabase = getSupabaseClient();

      // Paso 1: la sesión del propio usuario cambia su contraseña.
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }

      // Paso 2: liberar el flag (requiere service_role, ver la ruta).
      const res = await fetch(COMPLETE_PASSWORD_CHANGE_PATH, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          body.error ?? 'Password changed, but the account could not be unlocked. Try again.',
        );
        return;
      }

      /*
       * El gate lee `app_metadata` del TOKEN, no de la base. Sin refrescar la
       * sesión, el token todavía dice must_change_password: true y la persona
       * rebotaría de vuelta acá pese a haber cambiado la contraseña.
       */
      await supabase.auth.refreshSession();
      router.replace(DEFAULT_LANDING);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
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
          <h1 className="auth-heading">Choose a new password</h1>
          <p className="auth-subtitle">
            Your account uses a temporary password. Set your own to continue.
          </p>

          <form onSubmit={onSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="password" className="auth-label">
                New password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_LENGTH} characters`}
                className="auth-input"
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="confirm" className="auth-label">
                Confirm new password
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="auth-input"
                required
              />
            </div>

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set password'}
            </button>

            {error && (
              <p role="alert" className="auth-error">
                {error}
              </p>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
