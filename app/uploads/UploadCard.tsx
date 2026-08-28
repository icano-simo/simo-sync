'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UploadIcon, FileSheetIcon } from '@/components/ui/icons';

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

/** Etiqueta y color de pill por estado. Un solo lugar para las tres variantes. */
const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  ok: { label: 'ok', className: 'pill pill--ok' },
  validation_failed: { label: 'validación', className: 'pill pill--warn' },
  error: { label: 'error', className: 'pill pill--err' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Lo que la ruta devuelve sobre el sync que dispara al terminar la carga. */
type SyncInfo = {
  disparado?: boolean;
  confirmado?: boolean;
  ok?: boolean | null;
  error?: string | null;
};

/**
 * Qué decirle a quien acaba de subir el archivo sobre la app de Commercial
 * Activity.
 *
 * `null` cuando la fuente no alimenta ninguna tabla sincronizada: la mayoría no
 * lo hace, y una línea sobre un sync que no corresponde sólo confunde.
 *
 * Cuando el sync falla NO se muestra como error: el archivo ya está cargado. Lo
 * único que cambia es cuándo lo ve la otra app, y eso es lo que dice el texto.
 */
function syncMessage(sync: SyncInfo | undefined): string | null {
  if (!sync) return null;

  if (sync.disparado && sync.confirmado && sync.ok) {
    return 'Commercial Activity ya quedó actualizada.';
  }
  if (sync.disparado && !sync.confirmado) {
    return 'Actualizando Commercial Activity… puede tardar un minuto; no hace falta esperar acá.';
  }
  if (sync.disparado || sync.error) {
    return 'Los datos ya están en BigQuery. Commercial Activity se actualiza en la corrida de las 08:00 UTC.';
  }
  return null;
}

export default function UploadCard({ source, recent }: { source: SourceRow; recent: LoadEntry[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const busy = progress !== null;
  // El <input> real está oculto y lo dispara su <label>: el control nativo no
  // se puede estilar igual entre navegadores. El id tiene que ser único porque
  // hay una tarjeta por fuente en la misma página.
  const inputId = `file-${source.source_key}`;

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
    <section className="source-card">
      <div className="source-card__head">
        <h2 className="source-card__title">{source.display_name}</h2>
        <span className="source-card__target">
          {source.target_dataset}.{source.target_table}
          {source.sheet_name ? ` · hoja "${source.sheet_name}"` : ''}
        </span>
      </div>

      <div className="upload-row">
        <input
          ref={inputRef}
          id={inputId}
          className="upload-file"
          type="file"
          accept=".xlsx,.csv"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
          }}
        />
        <label htmlFor={inputId} className="btn">
          <FileSheetIcon size={14} />
          Elegir archivo
        </label>

        <button type="button" className="btn btn--primary" onClick={upload} disabled={!file || busy}>
          <UploadIcon size={14} />
          {busy ? 'Subiendo…' : 'Subir'}
        </button>

        {file ? <span className="upload-filename">{file.name}</span> : null}
      </div>

      {progress !== null ? (
        <div
          className="upload-bar"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <i className="upload-bar__fill" style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {progress === 100 ? (
        <div className="upload-result">Archivo subido. Validando y cargando a BigQuery…</div>
      ) : null}

      {result?.kind === 'ok'
        ? (() => {
            const nota = syncMessage(result.body.sync as SyncInfo | undefined);
            return (
              <div className="upload-result upload-result--ok">
                Cargadas <strong>{String(result.body.filas_en_tabla)}</strong> filas en{' '}
                {String(result.body.destino)} ({String(result.body.columnas_cargadas)} columnas
                {result.body.filas_descartadas
                  ? `, ${String(result.body.filas_descartadas)} filas descartadas`
                  : ''}
                ).
                {nota ? <div className="upload-result__note">{nota}</div> : null}
              </div>
            );
          })()
        : null}

      {result?.kind === 'err' ? (
        <div className="upload-result upload-result--err">
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

      <div className="loads-scroll">
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
                <td colSpan={4} className="loads__empty">
                  Sin cargas todavía.
                </td>
              </tr>
            ) : (
              recent.map((entry) => {
                const style = STATUS_STYLE[entry.status] ?? {
                  label: entry.status,
                  className: 'pill',
                };
                return (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.uploaded_at)}</td>
                    <td title={entry.error_message ?? undefined}>{entry.file_name ?? '—'}</td>
                    <td>{entry.rows_loaded ?? '—'}</td>
                    <td>
                      <span className={style.className}>{style.label}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
