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
  /**
   * Cómo terminó el sync que disparó esta carga. `null` = no se disparó
   * ninguno: la fuente no alimenta una tabla sincronizada, o la carga falló.
   *
   * Existe porque la respuesta de la carga casi nunca alcanza a saberlo -- el
   * sync tarda ~31 segundos y la carga espera 5. Sin esta columna, un sync
   * fallido sólo quedaba en el log de Vercel.
   */
  sync_status: 'ok' | 'error' | null;
  sync_error: string | null;
};

type Result =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'err'; message: string; detail?: Record<string, unknown> };

/** Una columna del archivo elegido, tal como la devuelve el previo. */
type PreviewColumn = {
  posicion: number;
  /** Como viene en el archivo. */
  original: string;
  /** Como va a llamarse en BigQuery. */
  normalizado: string;
  se_descarta: boolean;
};

type PreviewBody = {
  archivo: string;
  hoja: string | null;
  fila_encabezado: number;
  filas: number;
  filas_descartadas: number;
  columnas: PreviewColumn[];
  drop_sin_coincidencia: string[];
};

type Preview =
  | { kind: 'loading' }
  | { kind: 'ok'; data: PreviewBody }
  | { kind: 'err'; message: string };

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

/** Un branch que apareció en el archivo y todavía nadie decidió. */
type PendingBranch = { branch_code: string; people: number };

/**
 * El aviso de branches sin decidir.
 *
 * Va SEPARADO del resultado de la carga y con el estilo de advertencia, aunque
 * la carga haya salido bien: es lo único de esta pantalla sobre lo que hay que
 * actuar. Un branch nuevo entró igual --por diseño-- y su gente ya está en
 * BigQuery; lo que falta es que alguien decida si pertenece a la división.
 *
 * Se nombran los branches y cuánta gente traen, porque eso es lo que hace la
 * diferencia entre "decido esto ahora" y "lo veo mañana".
 */
function pendingNotice(pending: PendingBranch[] | undefined | null) {
  if (!pending || pending.length === 0) return null;

  const total = pending.reduce((n, b) => n + b.people, 0);
  const lista = pending.map((b) => `${b.branch_code} (${b.people})`).join(', ');

  return (
    <div className="upload-result upload-result--warn">
      <strong>
        {pending.length === 1 ? '1 branch sin decidir' : `${pending.length} branches sin decidir`}
      </strong>
      : {lista}. {total === 1 ? 'Esa persona entró' : `Esas ${total} personas entraron`} a la carga;
      falta decidir si el branch es de la división.
    </div>
  );
}

/** Lo que la ruta devuelve sobre el sync que dispara al terminar la carga. */
type SyncInfo = {
  disparado?: boolean;
  confirmado?: boolean;
  ok?: boolean | null;
  error?: string | null;
};

/**
 * Qué app consume cada fuente. Se nombra la app y no la tabla porque es lo que
 * quien sube el archivo reconoce -- va a ir a mirar ahí si el dato apareció.
 */
const APP_POR_FUENTE: Record<string, string> = {
  encompass: 'Commercial Activity',
  pipeline: 'Forecast & Pipeline',
  // Los dos rosters terminan en la misma tabla y se miran en la misma pantalla,
  // así que dicen lo mismo aunque suban archivos distintos.
  roster_co: 'Admin',
  roster_us: 'Admin',
};

/**
 * Qué decirle a quien acaba de subir el archivo sobre la app que lee estos
 * datos.
 *
 * `null` cuando la fuente no alimenta ninguna tabla sincronizada: la mayoría no
 * lo hace, y una línea sobre un sync que no corresponde sólo confunde.
 *
 * Cuando el sync falla NO se muestra como error: el archivo ya está cargado. Lo
 * único que cambia es cuándo lo ve la otra app, y eso es lo que dice el texto.
 */
function syncMessage(sync: SyncInfo | undefined, sourceKey: string): string | null {
  if (!sync) return null;

  const app = APP_POR_FUENTE[sourceKey] ?? 'la app que consume estos datos';

  if (sync.disparado && sync.confirmado && sync.ok) {
    return `${app} ya quedó actualizada.`;
  }
  if (sync.disparado && !sync.confirmado) {
    return `Actualizando ${app}… puede tardar un minuto; no hace falta esperar acá.`;
  }
  if (sync.disparado || sync.error) {
    return `Los datos ya están en BigQuery. ${app} se actualiza en la corrida de las 08:00 UTC.`;
  }
  return null;
}

/**
 * La celda "Sync" del historial: cómo terminó el sync de esa carga.
 *
 * Es lo que hace que un sync fallido deje de ser invisible. La respuesta de la
 * carga casi nunca alcanza a saberlo --el sync tarda ~31 segundos y la carga
 * espera 5-- así que este historial es el lugar donde el resultado aparece,
 * la próxima vez que alguien abre la pantalla.
 *
 * `—` cubre dos casos que no conviene distinguir acá: la fuente no alimenta
 * ninguna tabla sincronizada, o el sync todavía está corriendo. Los dos
 * significan "no hay nada que reportar todavía", y una carga que acaba de pasar
 * muestra `—` por unos segundos hasta que el sync termina.
 */
function syncCell(entry: LoadEntry) {
  if (entry.sync_status === 'ok') return <span className="pill pill--ok">ok</span>;
  if (entry.sync_status === 'error') {
    // El mensaje va en el title y no en la celda: es largo (trae el JSON del
    // sync) y la tabla tiene que seguir siendo legible de un vistazo.
    return (
      <span className="pill pill--err" title={entry.sync_error ?? undefined}>
        falló
      </span>
    );
  }
  return <span className="loads__empty">—</span>;
}

/**
 * Las columnas que trae el archivo elegido, con los dos nombres.
 *
 * POR QUÉ ESTÁ ACÁ. El 2 de septiembre `roster_co` necesitó cinco intentos y
 * `hr_hiring` tres, todos por lo mismo: `uploads.source` tenía un nombre de
 * columna que el archivo no usa, y la única forma de enterarse era fallar.
 * 'Branch #' contra 'Branch'. 'unnamed_38' contra 'column_2'. '#' contra
 * 'column'. Con las columnas a la vista antes de subir, esa diferencia se ve
 * sin tener que preguntarle a nadie.
 *
 * Las dos columnas de la tabla se llaman "En el archivo" y "En BigQuery" y no
 * "original" y "normalizado": lo que hace falta saber es de qué lado está cada
 * nombre, no cómo se llama la transformación.
 *
 * NO OPINA. No dice si una columna falta, si sobra o si el nombre está mal.
 * Decidir qué columna es cuál es de quien configura la fuente.
 */
function ColumnPreview({ data }: { data: PreviewBody }) {
  return (
    <>
      {/*
        `open` por defecto: la pantalla existe para que las columnas se VEAN,
        no para que haya un lugar donde buscarlas. El scroll propio de la tabla
        es lo que evita que 58 filas empujen el historial fuera de la vista.
      */}
      <details className="cols" open>
        <summary className="cols__summary">
          <strong>{data.columnas.length}</strong>
          {data.columnas.length === 1 ? ' columna detectada' : ' columnas detectadas'}
          {data.hoja ? ` · hoja "${data.hoja}"` : ''} · encabezado en la fila{' '}
          {data.fila_encabezado} · {data.filas} filas
          {data.filas_descartadas ? `, ${data.filas_descartadas} descartadas` : ''}
        </summary>

        <div className="cols__scroll">
          <table className="cols__table">
            <thead>
              <tr>
                <th>#</th>
                <th>En el archivo</th>
                <th>En BigQuery</th>
              </tr>
            </thead>
            <tbody>
              {data.columnas.map((c) => (
                <tr key={c.posicion}>
                  <td className="cols__pos">{c.posicion}</td>
                  <td>
                    {/*
                      Un encabezado vacío es un caso real y no un error de
                      lectura: es de donde salen 'column' y 'column_2'. Decirlo
                      explícitamente es lo que hace que ese nombre se entienda.
                    */}
                    {c.original === '' ? (
                      <span className="cols__blank">(sin nombre)</span>
                    ) : (
                      c.original
                    )}
                  </td>
                  <td>
                    <code className="cols__norm">{c.normalizado}</code>
                    {c.se_descarta ? <span className="cols__tag">se descarta</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
          Cuál de los dos nombres va en cuál lista. `required_columns` compara
          contra el nombre CRUDO y `drop_columns` contra el NORMALIZADO -- dos
          listas en la misma fila de `uploads.source` que se comparan contra
          cosas distintas (ver la nota de `dropColumns` en lib/uploads/parse.ts).
          Sin esta línea, tener los dos nombres a la vista igual deja que copiar
          el equivocado, que es la mitad del problema que esta pantalla resuelve.
        */}
        <p className="cols__legend">
          Al configurar la fuente: <code>required_columns</code> usa el nombre de la izquierda,{' '}
          <code>drop_columns</code> el de la derecha.
        </p>
      </details>

      {/*
        Un `drop_columns` que no coincide NO FALLA: la carga sale bien y la
        columna sensible del roster de Colombia se escribe a BigQuery igual.
        Todos los demás desajustes de nombres se anuncian al fallar la carga;
        éste se anuncia no pasando nada, y por eso es el único que esta pantalla
        señala. Va FUERA del <details> para que no se pueda plegar.
      */}
      {data.drop_sin_coincidencia.length > 0 ? (
        <div className="upload-result upload-result--warn">
          <strong>
            {data.drop_sin_coincidencia.length === 1
              ? '1 columna configurada para descartarse no está en el archivo'
              : `${data.drop_sin_coincidencia.length} columnas configuradas para descartarse no están en el archivo`}
          </strong>
          : {data.drop_sin_coincidencia.join(', ')}. Con esos nombres no coincide ninguna columna,
          así que no se van a descartar.
        </div>
      ) : null}
    </>
  );
}

export default function UploadCard({ source, recent }: { source: SourceRow; recent: LoadEntry[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewAbort = useRef<AbortController | null>(null);

  const busy = progress !== null;
  // El <input> real está oculto y lo dispara su <label>: el control nativo no
  // se puede estilar igual entre navegadores. El id tiene que ser único porque
  // hay una tarjeta por fuente en la misma página.
  const inputId = `file-${source.source_key}`;

  /**
   * Elegir un archivo dispara el previo de columnas.
   *
   * El previo NO bloquea nada: si falla, se muestra como aviso y el botón de
   * Subir sigue habilitado. Es una ayuda para ver los nombres antes de cargar,
   * no un permiso para cargar -- la validación que decide sigue estando en la
   * ruta de carga, que es la única que puede negarse.
   */
  function chooseFile(next: File | null) {
    /*
     * Un previo en vuelo de un archivo anterior deja de interesar: si
     * contestara después de que se eligió otro, mostraría las columnas del
     * archivo equivocado, y eso es peor que no mostrar nada.
     */
    previewAbort.current?.abort();
    previewAbort.current = null;

    setFile(next);
    setResult(null);
    setPreview(null);
    if (!next) return;

    const controller = new AbortController();
    previewAbort.current = controller;
    setPreview({ kind: 'loading' });

    const form = new FormData();
    form.append('file', next);

    fetch(`/api/upload/${encodeURIComponent(source.source_key)}/preview`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok && body.ok) {
          setPreview({ kind: 'ok', data: body as unknown as PreviewBody });
        } else {
          setPreview({ kind: 'err', message: String(body.error ?? `HTTP ${res.status}`) });
        }
      })
      .catch((err: unknown) => {
        // Abortar es lo que hace `chooseFile` al cambiar de archivo: no es un fallo.
        if (controller.signal.aborted) return;
        setPreview({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
      });
  }

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
        // El previo describía un archivo que ya no está elegido: sin nombre de
        // archivo al lado, esa lista de columnas quedaría sin contexto.
        setPreview(null);
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
          onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
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

      {/*
        Las columnas del archivo elegido, ANTES de subir. Va inmediatamente
        debajo del control y arriba de la barra: es información sobre lo que se
        acaba de elegir, así que se lee en el mismo movimiento.
      */}
      {preview?.kind === 'loading' ? (
        <div className="upload-result">Leyendo las columnas del archivo…</div>
      ) : null}

      {preview?.kind === 'err' ? (
        <div className="upload-result upload-result--warn">
          No se pudieron leer las columnas: {preview.message}
          <div className="upload-result__note">
            Es sólo el previo — el archivo se puede subir igual.
          </div>
        </div>
      ) : null}

      {preview?.kind === 'ok' ? <ColumnPreview data={preview.data} /> : null}

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
            const nota = syncMessage(result.body.sync as SyncInfo | undefined, source.source_key);
            const pendientes = pendingNotice(
              result.body.branches_pendientes as PendingBranch[] | null | undefined,
            );
            return (
              <>
              <div className="upload-result upload-result--ok">
                Cargadas <strong>{String(result.body.filas_en_tabla)}</strong> filas en{' '}
                {String(result.body.destino)} ({String(result.body.columnas_cargadas)} columnas
                {result.body.filas_descartadas
                  ? `, ${String(result.body.filas_descartadas)} filas descartadas`
                  : ''}
                ).
                {nota ? <div className="upload-result__note">{nota}</div> : null}
              </div>
              {pendientes}
              </>
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
              {/*
                El estado del SYNC, aparte del de la carga. Son dos cosas
                distintas: la carga puede estar perfecta y el sync haber
                fallado, que es exactamente lo que pasó el 31 de agosto.
              */}
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="loads__empty">
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
                    <td>{syncCell(entry)}</td>
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
