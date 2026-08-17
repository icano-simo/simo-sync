// Keyless auth chain: Vercel OIDC -> STS -> service account impersonation.
// Extracted from app/api/bq-healthcheck/route.ts so the sync job and the
// health check share one client instead of each building their own.
//
// No credentials live here. All three values come from the environment and
// are configured in Vercel, never in the repo.
import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';
import { BigQuery } from '@google-cloud/bigquery';

const {
  GCP_PROJECT_ID,
  GCP_SERVICE_ACCOUNT_EMAIL,
  GCP_AUDIENCE,
} = process.env as Record<string, string>;

let cached: BigQuery | null = null;

export function getBigQueryClient(): BigQuery {
  // Reused across invocations on a warm lambda; the underlying auth client
  // refreshes its own access token, so caching does not pin a stale one.
  if (cached) return cached;

  const missing = [
    ['GCP_PROJECT_ID', GCP_PROJECT_ID],
    ['GCP_SERVICE_ACCOUNT_EMAIL', GCP_SERVICE_ACCOUNT_EMAIL],
    ['GCP_AUDIENCE', GCP_AUDIENCE],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing BigQuery env vars: ${missing.join(', ')}`);
  }

  const authClient = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: GCP_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: getVercelOidcToken,
    },
  })!;

  cached = new BigQuery({ projectId: GCP_PROJECT_ID, authClient });
  return cached;
}

/**
 * BigQuery wraps DATE / DATETIME / TIMESTAMP / TIME / NUMERIC values in
 * objects shaped `{ value: string }`. PostgREST would serialise those as
 * `{"value":"..."}` and the insert would fail on type mismatch, so unwrap
 * them to the primitive before handing rows to Supabase.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (val !== null && typeof val === 'object' && 'value' in (val as object)) {
      out[key] = (val as { value: unknown }).value;
    } else if (typeof val === 'bigint') {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}
