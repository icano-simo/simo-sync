// app/api/bq-healthcheck/route.ts
// Deploy to Vercel (or run `vercel dev`), then GET /api/bq-healthcheck
// Confirms: (1) Vercel OIDC -> impersonation works, (2) it can run a job,
// (3) it can read, and (4) which identity it's actually running as.

import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';
import { BigQuery } from '@google-cloud/bigquery';

export const dynamic = 'force-dynamic'; // never cache the check

const {
  GCP_PROJECT_ID,
  GCP_SERVICE_ACCOUNT_EMAIL,
  GCP_AUDIENCE,
} = process.env as Record<string, string>;

export async function GET() {
  try {
    // GCP provider uses "Allowed audiences" = https://vercel.com/simo-logic (Vercel's
    // default token audience), so no audience override is needed on the token.
    // `audience` below is the STS target (provider resource name) — a different field.
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

    const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID, authClient });

    // 1) Runs a query job AND reads a result. SESSION_USER() returns the
    //    identity actually executing the query -> should be the service account.
    const [rows] = await bigquery.query({
      query: 'SELECT SESSION_USER() AS running_as, CURRENT_TIMESTAMP() AS server_time',
    });

    // 2) Confirms read access to dataset metadata.
    const [datasets] = await bigquery.getDatasets();

    return Response.json({
      ok: true,
      running_as: rows?.[0]?.running_as ?? null,     // expect: simoos-app-bigquery@...
      server_time: rows?.[0]?.server_time ?? null,
      datasets_visible: datasets.map((d) => d.id),
    });
  } catch (err: any) {
    // Surfaces the real failure so you can tell auth errors from permission errors.
    return Response.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
