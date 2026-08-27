/**
 * Cliente de BigQuery CON PERMISO DE ESCRITURA, para las cargas de archivos.
 *
 * Misma cadena keyless que `lib/bigquery.ts` (Vercel OIDC -> STS ->
 * impersonación de service account), pero impersonando
 * GCP_WRITER_SERVICE_ACCOUNT_EMAIL.
 *
 * DELIBERADAMENTE SEPARADO del cliente del sync. La service account del sync es
 * de SOLO LECTURA a propósito: si las cargas la reutilizaran, habría que darle
 * permiso de escritura y se perdería esa garantía para el job nocturno, que
 * nunca debe poder modificar nada en BigQuery.
 *
 * No hay credenciales acá. Todo sale del entorno y se configura en Vercel.
 */
import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';
import { BigQuery } from '@google-cloud/bigquery';

const {
  GCP_PROJECT_ID,
  GCP_WRITER_SERVICE_ACCOUNT_EMAIL,
  GCP_AUDIENCE,
} = process.env as Record<string, string>;

/**
 * Datasets donde esta credencial puede escribir.
 *
 * La restricción REAL es de IAM: esta lista no otorga nada, sólo evita que una
 * fila mal configurada en `uploads.source` termine en un 403 de Google a mitad
 * de la carga en vez de en un mensaje que dice cuál es el dataset y cuáles son
 * los permitidos.
 *
 * Que la lista y el IAM sean dos cosas separadas corta para los dos lados:
 *   - un dataset acá sin permiso de IAM falla igual, con el 403 de Google;
 *   - un dataset con permiso de IAM pero fuera de esta lista se rechaza acá.
 * O sea que agregar uno son SIEMPRE dos pasos, y este archivo es el segundo.
 *
 *   lending_marts     encompass_loans_stage, blast_gl_stage
 *   hr_centralizado   active_roster_stage (roster_co), hr_usa_directory_stage (roster_us)
 *   comp_marts        —
 */
export const ALLOWED_WRITE_DATASETS = new Set([
  'lending_marts',
  'hr_centralizado',
  'comp_marts',
]);

let cached: BigQuery | null = null;

export function getBigQueryWriterClient(): BigQuery {
  if (cached) return cached;

  const missing = [
    ['GCP_PROJECT_ID', GCP_PROJECT_ID],
    ['GCP_WRITER_SERVICE_ACCOUNT_EMAIL', GCP_WRITER_SERVICE_ACCOUNT_EMAIL],
    ['GCP_AUDIENCE', GCP_AUDIENCE],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing BigQuery writer env vars: ${missing.join(', ')}`);
  }

  const authClient = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: GCP_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_WRITER_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: getVercelOidcToken,
    },
  })!;

  cached = new BigQuery({ projectId: GCP_PROJECT_ID, authClient });
  return cached;
}

/** Lanza si el dataset destino no es uno de los permitidos. */
export function assertWritableDataset(dataset: string): void {
  if (!ALLOWED_WRITE_DATASETS.has(dataset)) {
    const allowed = [...ALLOWED_WRITE_DATASETS].join(', ');
    throw new Error(`dataset "${dataset}" is not writable by this job; allowed: ${allowed}`);
  }
}
