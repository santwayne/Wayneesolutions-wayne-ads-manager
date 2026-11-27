import pg from 'pg';
import { config } from '../config.js';

// Postgres NUMERIC/BIGINT come back as strings; parse the ones we use for money/metrics.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pg.types.setTypeParser(1082, (v) => v);                                 // date -> 'YYYY-MM-DD' (no timezone shift)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Org-scoped data access. Every query for tenant data must go through this so the
 * org_id check is never forgotten (spec: "row-level org_id check har query mein").
 * Postgres RLS is also enabled in the migration as a second wall; we set
 * app.org_id per transaction so the policies apply.
 */
export async function withOrg(orgId, fn) {
  if (!orgId) throw new Error('withOrg called without orgId');
  return tx(async (client) => {
    await client.query("SELECT set_config('app.org_id', $1, true)", [String(orgId)]);
    return fn(client);
  });
}
