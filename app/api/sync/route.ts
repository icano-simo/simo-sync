/**
 * BigQuery -> Supabase sync. Runs on a Vercel cron at 08:00 UTC.
 *
 * Target tables and their primary keys already exist and are not created or
 * altered here. Rows are upserted, then rows that no longer exist upstream are
 * swept; Salesforce is the source of truth for all five. TRUNCATE is never used.
 *
 * Order of operations is deliberate:
 *   1. authorize  2. freshness gate  3. write  4. sweep  5. verify by counting
 * The freshness gate runs before any write so stale BigQuery data can never
 * overwrite good rows -- keeping yesterday's data beats silently replacing it
 * with the day before's. Verification runs last so the counts reflect the
 * post-sweep state.
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getBigQueryClient, normalizeRow } from '@/lib/bigquery';
import { getSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
// ~24,700 rows for leads_v2 alone; the default 15s ceiling is not enough.
export const maxDuration = 300;

const BATCH_SIZE = 500;
const MAX_DATA_AGE_HOURS = 30;

/**
 * Holds 18 rows with source='manual' -- human decisions with no upstream copy
 * to rebuild from. Nothing in this job may write to it OR sweep it; both paths
 * check this set, and the write path asserts at request time.
 */
const NEVER_WRITE = new Set(['master_assignments']);

/**
 * The only tables the sweep may delete from. An allowlist rather than a
 * denylist: a table added to SYNCS later is not sweepable until it is named
 * here deliberately. NEVER_WRITE is still checked on top of this.
 */
const SWEEPABLE = new Set([
  'leads_v2',
  'opportunities_v2',
  'calls_daily',
  'dim_bd',
  'realtor_owner_map_v2',
]);

type TableSyncBase = {
  /** Label used in logs and in the response. */
  name: string;
  /** BigQuery source, dataset-qualified. */
  source: string;
  /** Supabase table inside the b2b_metrics schema. */
  target: string;
  /** Column list for ON CONFLICT; comma-separated for composite keys. */
  conflict: string;
};

/**
 * A sync reads either a plain projection over `source` (`select`) or, when the
 * source needs real SQL to reach one row per conflict key, a full statement
 * (`query`). Exactly one of the two is set -- the union makes supplying both,
 * or neither, a type error rather than a runtime surprise.
 */
type TableSync =
  | (TableSyncBase & {
      /** Projection. Renames happen here in SQL rather than in JS. */
      select: string;
      query?: never;
    })
  | (TableSyncBase & {
      select?: never;
      /** Full SQL statement. Takes precedence over `select`. */
      query: string;
    });

/** Resolves a sync spec to the SQL actually sent to BigQuery. */
function buildQuery(spec: TableSync): string {
  if (spec.query) return spec.query;
  return `SELECT ${spec.select} FROM \`${spec.source}\``;
}

const SYNCS: TableSync[] = [
  {
    name: 'leads',
    source: 'b2b_marts.fct_leads',
    target: 'leads_v2',
    conflict: 'lead_id',
    select: [
      'lead_id',
      'referred_by',
      'lead_owner',
      'branch',
      'create_date',
      'first_name',
      'last_name',
      'lead_status',
      'converted',
      'realtor_key',
      'realtor_bd AS realtor_bd_name',
    ].join(', '),
  },
  {
    name: 'opportunities',
    source: 'b2b_marts.fct_opportunities',
    target: 'opportunities_v2',
    conflict: 'opportunity_id',
    select: [
      'opportunity_id',
      'opportunity_name',
      'created_date',
      'stage',
      'current_status',
      'current_milestone',
      'disbursement_date',
      'pre_approved_date',
      'ratified_date',
      'est_closing_date',
      'pre_qualified_date',
      'closed_won_date',
      'opportunity_owner',
      'loan_number',
      'loan_officer',
      'loan_amount',
      'total_loan_amount',
      'loan_status',
      'loan_folder',
      'branch',
      'account_name',
      'opportunity_team',
      'lender',
      'strategy',
      'healthiness',
      'referred_by',
      'realtor_key',
      'is_won',
      'excluded_from_metrics',
      'realtor_bd AS realtor_bd_name',
    ].join(', '),
  },
  {
    name: 'calls_daily',
    source: 'b2b_marts.fct_calls_daily',
    target: 'calls_daily',
    conflict: 'call_date,bd_id,record_type',
    select: [
      'call_date',
      'bd_id',
      'record_type',
      'total_calls',
      'effective_calls',
      'bd_name AS assigned_to',
    ].join(', '),
  },
  {
    name: 'dim_bd',
    source: 'b2b_marts.dim_bd',
    target: 'dim_bd',
    conflict: 'bd_id',
    select: ['bd_id', 'bd_name', 'bd_title', 'is_active'].join(', '),
  },
  {
    // All 15 columns are named identically on both sides, so they are copied
    // wholesale -- but the view is at recruitment-opportunity grain, not realtor
    // grain: 4,085 rows over 3,873 distinct realtor_keys. A key recurs with
    // *different* owners because different BDs worked that realtor at different
    // times. Upserting the raw view would make two rows in one batch hit the
    // same conflict key and Postgres would reject the whole batch.
    //
    // So collapse to one row per key, most recent first. "Most recent BD wins"
    // is deterministic, unlike the app's current dedupMap where whichever row
    // happens to land last in arbitrary file order wins.
    //
    // The date columns alone are not enough: 3 groups (6 rows) tie on both
    // leading dates, and 2 of them carry different owners, so ROW_NUMBER would
    // pick arbitrarily and those realtors would flip BD between runs. The view
    // exposes no unique id, so the tiebreak is built from the columns it has:
    // two more dates, then `owner` alphabetically. Alphabetical owner is
    // arbitrary as business logic but STABLE, which is the property that
    // matters -- a realtor lands on the same BD every run.
    name: 'realtor_owner_map',
    source: 'app_b2b_metrics.realtor_owner_map',
    target: 'realtor_owner_map_v2',
    conflict: 'realtor_key',
    query: `
      SELECT * EXCEPT(rn) FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY realtor_key
          ORDER BY created_date DESC NULLS LAST,
                   meeting_attended_date DESC NULLS LAST,
                   invite_sent_date DESC NULLS LAST,
                   last_referral_date DESC NULLS LAST,
                   owner ASC
        ) AS rn
        FROM \`app_b2b_metrics.realtor_owner_map\`
      ) WHERE rn = 1
    `,
  },
];

// MIN, not MAX: the most stale table gates the run. With MAX, one table
// syncing on time would mask another sitting three days behind, and the job
// would write those stale rows over good ones.
const FRESHNESS_QUERY = `
  SELECT MIN(last_modified_time) AS oldest_last_modified_time
  FROM salesforce.__TABLES__
  WHERE table_id IN ('Lead', 'Opportunity', 'Task', 'User')
`;

type TableResult = {
  tabla: string;
  filas_bigquery: number;
  filas_supabase: number | null;
  filas_borradas: number | null;
  coincide: boolean;
  duracion_ms: number;
  error: string | null;
};

/** Constant-time compare so the secret cannot be recovered byte by byte. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed when unconfigured

  const provided = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Age of the *most stale* Salesforce -> BigQuery load, in hours.
 * Throws if the probe returns nothing, so an unanswerable freshness question
 * aborts the run rather than defaulting to "probably fine".
 */
async function getDataAgeHours(
  bq: ReturnType<typeof getBigQueryClient>,
): Promise<{ ageHours: number; lastModified: string }> {
  const [rows] = await bq.query({ query: FRESHNESS_QUERY });
  const raw = rows?.[0]?.oldest_last_modified_time;
  const ms = raw === null || raw === undefined ? NaN : Number(raw);

  if (!Number.isFinite(ms)) {
    throw new Error(
      'salesforce.__TABLES__ returned no last_modified_time for Lead/Opportunity/Task/User',
    );
  }

  return {
    ageHours: (Date.now() - ms) / 3_600_000,
    lastModified: new Date(ms).toISOString(),
  };
}

async function syncTable(
  spec: TableSync,
  bq: ReturnType<typeof getBigQueryClient>,
  sb: ReturnType<typeof getSupabaseClient>,
  syncedAt: string,
): Promise<TableResult> {
  const started = Date.now();

  const [rawRows] = await bq.query({ query: buildQuery(spec) });

  // synced_at is written explicitly on every row. A column DEFAULT now() only
  // fires on INSERT, so on an upsert that UPDATEs an existing row it would
  // never advance -- leaving the column useless and the sweep below unable to
  // tell a refreshed row from an abandoned one.
  const rows = rawRows.map((r) => ({ ...normalizeRow(r), synced_at: syncedAt }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from(spec.target)
      .upsert(batch, { onConflict: spec.conflict, ignoreDuplicates: false });

    if (error) {
      throw new Error(
        `upsert into ${spec.target} failed at row ${i}: ${error.message}`,
      );
    }
  }

  // --- Sweep rows that no longer exist upstream. ---
  // Every guard must hold. Reaching this line already means the write above
  // completed without error, since any failure threw.
  let filas_borradas: number | null = null;

  if (NEVER_WRITE.has(spec.target)) {
    throw new Error(`refusing to sweep protected table ${spec.target}`);
  }

  if (rows.length === 0) {
    // A source returning zero rows is a source failure, not a mass deletion.
    // Sweeping here would empty the table on an upstream hiccup.
    console.warn(
      `[sync] ${spec.name}: source returned 0 rows, skipping sweep`,
    );
  } else if (!SWEEPABLE.has(spec.target)) {
    console.warn(`[sync] ${spec.name}: not in SWEEPABLE, skipping sweep`);
  } else {
    const { count: deleted, error: deleteError } = await sb
      .from(spec.target)
      .delete({ count: 'exact' })
      .lt('synced_at', syncedAt);

    if (deleteError) {
      throw new Error(
        `sweep of ${spec.target} failed: ${deleteError.message}`,
      );
    }
    filas_borradas = deleted ?? 0;
  }

  // Verify against the server rather than trusting that no error was thrown.
  // Runs after the sweep so the count reflects the final state.
  const { count, error: countError } = await sb
    .from(spec.target)
    .select('*', { count: 'exact', head: true });

  if (countError) {
    throw new Error(`count on ${spec.target} failed: ${countError.message}`);
  }

  const duracion_ms = Date.now() - started;
  console.log(
    `[sync] ${spec.name}: bq=${rows.length} supabase=${count} ` +
      `borradas=${filas_borradas ?? 'n/a'} ${duracion_ms}ms`,
  );

  return {
    tabla: spec.target,
    filas_bigquery: rows.length,
    filas_supabase: count ?? null,
    filas_borradas,
    coincide: count === rows.length,
    duracion_ms,
    error: null,
  };
}

export async function GET(req: NextRequest) {
  const started = Date.now();

  if (!isAuthorized(req)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const illegal = SYNCS.filter((s) => NEVER_WRITE.has(s.target));
  if (illegal.length) {
    return Response.json(
      {
        ok: false,
        error: `refusing to run: protected table(s) targeted: ${illegal
          .map((s) => s.target)
          .join(', ')}`,
      },
      { status: 500 },
    );
  }

  let bq: ReturnType<typeof getBigQueryClient>;
  let sb: ReturnType<typeof getSupabaseClient>;
  try {
    bq = getBigQueryClient();
    sb = getSupabaseClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }

  // --- Freshness gate: nothing is written past this point if it fails. ---
  let freshness: { ageHours: number; lastModified: string };
  try {
    freshness = await getDataAgeHours(bq);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, aborted: true, stage: 'freshness_check', error: message },
      { status: 503 },
    );
  }

  if (freshness.ageHours > MAX_DATA_AGE_HOURS) {
    console.warn(
      `[sync] aborted: data is ${freshness.ageHours.toFixed(1)}h old`,
    );
    return Response.json(
      {
        ok: false,
        aborted: true,
        stage: 'freshness_check',
        error:
          `BigQuery data is ${freshness.ageHours.toFixed(1)}h old, over the ` +
          `${MAX_DATA_AGE_HOURS}h limit. Nothing was written.`,
        last_modified: freshness.lastModified,
        edad_horas: Number(freshness.ageHours.toFixed(2)),
        limite_horas: MAX_DATA_AGE_HOURS,
      },
      { status: 503 },
    );
  }

  // One timestamp for the whole run, taken before the first write. Every row
  // written this run carries it, and the sweep deletes anything older, so the
  // two halves cannot disagree about what "this run" means.
  const syncedAt = new Date().toISOString();

  // --- Write. One table failing must not stop the others. ---
  const resultados: TableResult[] = [];
  for (const spec of SYNCS) {
    try {
      resultados.push(await syncTable(spec, bq, sb, syncedAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sync] ${spec.name} failed: ${message}`);
      resultados.push({
        tabla: spec.target,
        filas_bigquery: 0,
        filas_supabase: null,
        filas_borradas: null,
        coincide: false,
        duracion_ms: 0,
        error: message,
      });
    }
  }

  const fallidas = resultados.filter((r) => r.error !== null);
  const desajustadas = resultados.filter((r) => r.error === null && !r.coincide);

  // With the sweep in place the target is a mirror of the source, so a count
  // mismatch is a real defect rather than expected drift, and fails the run.
  const ok = fallidas.length === 0 && desajustadas.length === 0;

  return Response.json(
    {
      ok,
      duracion_total_ms: Date.now() - started,
      synced_at: syncedAt,
      last_modified: freshness.lastModified,
      edad_horas: Number(freshness.ageHours.toFixed(2)),
      tablas_ok: resultados.length - fallidas.length,
      tablas_fallidas: fallidas.map((r) => r.tabla),
      tablas_con_desajuste: desajustadas.map((r) => r.tabla),
      resultados,
    },
    { status: ok ? 200 : 500 },
  );
}
