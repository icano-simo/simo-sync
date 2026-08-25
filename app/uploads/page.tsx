import { getServerClient } from '@/lib/supabase/server';
import UploadCard, { type LoadEntry, type SourceRow } from './UploadCard';

/**
 * Pantalla de cargas.
 *
 * Server Component: la lista de fuentes se resuelve en el servidor con la
 * sesión del usuario, así que las políticas de RLS de `uploads` aplican a esta
 * consulta igual que a cualquier otra. El navegador nunca recibe fuentes que no
 * le correspondan -- no se filtran del lado del cliente.
 *
 * Ojo: esto es presentación. La autorización que importa está en
 * `/api/upload/[source]`, que vuelve a verificar la asignación.
 *
 * El email de la sesión ya no se muestra acá: vive en el header del shell
 * (`components/layout/UserMenu.tsx`), igual que en el resto del portal.
 */
export const dynamic = 'force-dynamic';

export default async function UploadsPage() {
  const sb = await getServerClient('uploads');

  // El join trae sólo las fuentes asignadas: `user_source` está acotada por RLS
  // al email de la sesión, y el inner join sobre `source` descarta las inactivas.
  const { data, error } = await sb
    .from('user_source')
    .select('source_key, source!inner(source_key, display_name, target_dataset, target_table, min_rows_expected, sheet_name, is_active)')
    .eq('source.is_active', true);

  const sources: SourceRow[] = (data ?? [])
    .map((r) => (r as unknown as { source: SourceRow }).source)
    .filter(Boolean)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  // Últimas cargas de todas las fuentes del usuario en una sola consulta, y se
  // reparten en memoria: una consulta por tarjeta sería N+1 sin ninguna ventaja.
  const { data: logs } = await sb
    .from('load_log')
    .select('id, source_key, uploaded_at, file_name, rows_loaded, status, error_message')
    .order('uploaded_at', { ascending: false })
    .limit(100);

  const logsBySource = new Map<string, LoadEntry[]>();
  for (const entry of (logs ?? []) as LoadEntry[]) {
    const list = logsBySource.get(entry.source_key) ?? [];
    if (list.length < 5) list.push(entry);
    logsBySource.set(entry.source_key, list);
  }

  return (
    <div className="hub-container">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Data Uploads</h1>
          <p className="page-head__subtitle">
            Subí acá los archivos de fuentes externas. Sólo ves las fuentes que tenés asignadas.
          </p>
        </div>
      </div>

      {error ? (
        <div className="notice notice--err">No se pudieron leer las fuentes: {error.message}</div>
      ) : sources.length === 0 ? (
        <div className="notice">
          No tenés ninguna fuente asignada todavía.
          <br />
          Pedile al administrador de simoOS que te asigne una.
        </div>
      ) : (
        sources.map((source) => (
          <UploadCard
            key={source.source_key}
            source={source}
            recent={logsBySource.get(source.source_key) ?? []}
          />
        ))
      )}
    </div>
  );
}
