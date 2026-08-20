'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export type SourceRow = {
  source_key: string;
  display_name: string;
  target_dataset: string;
  target_table: string;
  min_rows_expected: number;
  sheet_name: string | null;
  is_active: boolean;
};

export type LoadEntry = {
  id: number;
  source_key: string;
  uploaded_at: string;
  file_name: string | null;
  rows_loaded: number | null;
  status: 'ok' | 'validation_failed' | 'error' | string;
  error_message: string | null;
};

type Result =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'err'; message: string; detail?: Record<string, unknown> };

const STATUS_LABEL: Record<string, string> = {
  ok: 'ok',
  validation_failed: 'validación',
  error: 'error',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function UploadCard({ source, recent }: { source: SourceRow; recent: LoadEntry[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const busy = progress !== null;

  /**
   * Se usa XMLHttpRequest y no fetch a propósito: fetch no expone progreso de
   * SUBIDA, y sin eso la barra sería decorativa. El archivo de Encompass pesa
   * varios MB, así que el progreso real es la diferencia entre "está andando" y
   * "se colgó".
   */
  function upload() {
    if (!file) return;

    setResult(null);
    setProgress(0);

    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/${encodeURIComponent(source.source_key)}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };

    // Terminada la subida, el servidor todavía parsea y carga a BigQuery. La
    // barra queda en 100 y el botón bloqueado: el trabajo no terminó.
    xhr.upload.onload = () => setProgress(100);

    xhr.onload = () => {
      setProgress(null);

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { error: `respuesta no-JSON (HTTP ${xhr.status})` };
      }

      if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
        setResult({ kind: 'ok', body });
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
        // Refresca el Server Component para que aparezca la carga en el historial.
        router.refresh();
      } else {
        setResult({
          kind: 'err',
          message: String(body.error ?? `HTTP ${xhr.status}`),
          detail: (body.detalle as Record<string, unknown>) ?? undefined,
        });
      }
    };

    xhr.onerror = () => {
      setProgress(null);
      setResult({ kind: 'err', message: 'falló la conexión con el servidor' });
    };

    xhr.send(form);
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{source.display_name}</h2>
        <span className="target">
          {source.target_dataset}.{source.target_table}
          {source.sheet_name ? ` · hoja "${source.sheet_name}"` : ''}
        </span>
      </div>

      <div className="row">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
          }}
        />
        <button className="primary" onClick={upload} disabled={!file || busy}>
          {busy ? 'Subiendo…' : 'Subir'}
        </button>
        {file ? <span className="filename">{file.name}</span> : null}
      </div>

      {progress !== null ? (
        <div className="bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {progress === 100 ? (
        <div className="result">Archivo subido. Validando y cargando a BigQuery…</div>
      ) : null}

      {result?.kind === 'ok' ? (
        <div className="result ok">
          Cargadas <strong>{String(result.body.filas_en_tabla)}</strong> filas en{' '}
          {String(result.body.destino)} ({String(result.body.columnas)} columnas
          {result.body.filas_descartadas ? `, ${String(result.body.filas_descartadas)} filas descartadas` : ''}).
        </div>
      ) : null}

      {result?.kind === 'err' ? (
        <div className="result err">
          {result.message}
          {result.detail ? (
            <ul>
              {Object.entries(result.detail).map(([k, v]) => (
                <li key={k}>
                  {k}: {Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <table className="loads">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Archivo</th>
            <th>Filas</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {recent.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ color: 'var(--muted)' }}>
                Sin cargas todavía.
              </td>
            </tr>
          ) : (
            recent.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.uploaded_at)}</td>
                <td title={entry.error_message ?? undefined}>{entry.file_name ?? '—'}</td>
                <td>{entry.rows_loaded ?? '—'}</td>
                <td>
                  <span className={`pill ${entry.status}`}>
                    {STATUS_LABEL[entry.status] ?? entry.status}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
