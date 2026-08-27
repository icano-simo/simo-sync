'use client';

import { useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@/lib/supabase/client';
import { hasAppAccess } from '@/lib/auth/appAccess';
import { DEFAULT_LANDING, NO_ACCESS_PATH } from '@/lib/auth/routes';
import '@/app/styles/auth.css';

/**
 * ============================================================================
 * LOGIN — Supabase Auth (email + contraseña)
 * ============================================================================
 *
 * Mismo proyecto de Supabase y mismos usuarios que el resto del portal: no se
 * crea ningún sistema de auth propio, sólo se inicia sesión contra simoOS-prod.
 *
 * Se firma con `getSupabaseClient()` -- el MISMO cliente que después usa la app.
 * Eso es lo que hace que el JWT viaje solo: `signInWithPassword` deja la sesión
 * guardada en ese cliente (en cookies, ver lib/supabase/client.ts), y el gate
 * del servidor y el fetch de subida la ven desde ahí. Con una instancia
 * distinta, la app seguiría llamando como `anon`.
 *
 * Markup y estilo portados de homesi-reporte-actividad sin cambios; lo único
 * propio de esta app es a dónde entra (DEFAULT_LANDING = /uploads).
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');

    try {
      const supabase = getSupabaseClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        // UN SOLO mensaje para contraseña incorrecta y para dirección
        // inexistente. Distinguirlos permitiría averiguar quién tiene cuenta
        // probando direcciones. Por eso no se muestra `signInError.message`:
        // Supabase a veces sí los distingue, y reenviarlo filtraría eso.
        setError('Incorrect email or password.');
        return;
      }

      // Alguien sin acceso a esta app va a /no-access y no a las cargas: el
      // gate lo rebotaría igual, y así ve el motivo real en vez de una
      // pantalla que parpadea.
      if (!hasAppAccess(data.user)) {
        router.replace(NO_ACCESS_PATH);
        router.refresh();
        return;
      }

      router.replace(DEFAULT_LANDING);
      // refresh() para que el gate vuelva a correr con la cookie ya escrita --
      // sin esto, la navegación puede resolverse con el árbol de rutas que el
      // cliente tenía cacheado de cuando no había sesión.
      router.refresh();
    } catch (err) {
      // Acá sí se muestra el mensaje real: este catch es para fallas de
      // configuración o de red, que no revelan nada sobre ninguna cuenta.
      setError(err instanceof Error ? err.message : 'Could not sign in. Try again.');
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
          <form onSubmit={onSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="email" className="auth-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@supremelending.com"
                className="auth-input"
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="password" className="auth-label">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="auth-input"
                required
              />
            </div>

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign In'}
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
