'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@/lib/supabase/client';
import { DEFAULT_LANDING } from '@/lib/auth/routes';
import '@/app/styles/app.css';

/**
 * Login con email/password de Supabase Auth contra simoOS-prod.
 *
 * El login se hace con el MISMO cliente del navegador que usa el resto de la
 * app (`getSupabaseClient`), que guarda la sesión en cookies: es lo que permite
 * que el gate del servidor la vea y que el fetch de subida viaje autenticado.
 *
 * No se comprueba `allowed_apps` acá. De eso se encarga el gate en el redirect
 * siguiente, que es un único lugar y no puede quedar desincronizado.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { error: signInError } = await getSupabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        setError(signInError.message);
        setBusy(false);
        return;
      }

      // `refresh()` antes de navegar: el gate corre en el servidor y necesita
      // ver la cookie nueva, que sin esto todavía no viajó.
      router.refresh();
      router.replace(DEFAULT_LANDING);
    } catch (err) {
      // Típicamente falta de configuración: el mensaje del cliente dice cuál.
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>simo-sync · Cargas de archivos</h1>
        <p>Entrá con tu cuenta de simoOS.</p>

        {error ? <p className="auth-err">{error}</p> : null}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span>Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
