import { config } from '../config.js';
import { query } from '../lib/db.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { createGraphClient, MetaApiError, assertWriteAllowed } from './graph.js';
import { notifyOwner } from '../notify/whatsapp.js';

/**
 * Token resolution.
 *  Phase 1 (agency mode): Wayne Business Manager system user token. Client ad accounts
 *  are shared to Wayne's BM via partner access, so one token covers them.
 *  Phase 2 (self-serve): per-org user token from Facebook Login for Business, long-lived,
 *  encrypted; validity checked before use; on expiry the owner gets a WhatsApp to reconnect.
 */
export async function storeConnection({ orgId, kind, token, scopes = [], expiresAt = null, metaUserId = null }) {
  const enc = await encryptSecret(token);
  const { rows } = await query(
    `INSERT INTO meta_connections (org_id, kind, token_enc, scopes, expires_at, meta_user_id, status, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',now()) RETURNING id`,
    [orgId, kind, enc, scopes, expiresAt, metaUserId],
  );
  return rows[0].id;
}

const VALIDITY_CACHE_MS = 15 * 60_000;

const defaultOnExpired = (conn) => notifyOwner(conn.org_id, '🔌 Aapka Meta (Facebook) connection expire ho gaya hai. Ads ka data aur alerts ruk gaye hain — app mein Settings → "Meta connect karo" dabayein.');

export async function tokenForAdAccount(adAccount, { onExpired = defaultOnExpired } = {}) {
  if (!adAccount.connection_id) {
    if (!config.meta.systemUserToken) throw new Error('META_SYSTEM_USER_TOKEN not set');
    return config.meta.systemUserToken;
  }
  const { rows } = await query('SELECT * FROM meta_connections WHERE id = $1', [adAccount.connection_id]);
  const conn = rows[0];
  if (!conn || conn.status !== 'active') throw new Error('Meta connection not active — reconnect needed');
  const token = await decryptSecret(conn.token_enc);
  if (conn.expires_at && new Date(conn.expires_at) < new Date()) {
    await query("UPDATE meta_connections SET status='expired' WHERE id=$1", [conn.id]);
    if (onExpired) await onExpired(conn);
    throw new Error('Meta token expired — reconnect needed');
  }

  const stale = !conn.last_checked_at || Date.now() - new Date(conn.last_checked_at).getTime() > VALIDITY_CACHE_MS;
  if (conn.kind === 'user' && stale) {
    const ok = await checkTokenValid(token);
    if (!ok) {
      await query("UPDATE meta_connections SET status='expired' WHERE id=$1", [conn.id]);
      if (onExpired) await onExpired(conn);
      throw new Error('Meta token expired — reconnect needed');
    }
    await query('UPDATE meta_connections SET last_checked_at=now() WHERE id=$1', [conn.id]);
  }
  return token;
}

export async function checkTokenValid(token) {
  if (!config.meta.appId || !config.meta.appSecret) return true;
  const appToken = `${config.meta.appId}|${config.meta.appSecret}`;
  try {
    const g = createGraphClient({ token: appToken });
    const r = await g.get('debug_token', { input_token: token });
    return Boolean(r.data?.is_valid);
  } catch (e) {
    if (e instanceof MetaApiError) return false;
    throw e;
  }
}

/**
 * Demo / review accounts (meta_account_id "act_demo..."): no Meta calls at all. Writes go
 * through the same safety checks (PAUSED creates, no billing) and return success, so the
 * MCP directory reviewers and sales demos can use every tool on a fully populated account.
 */
export function demoGraph() {
  let n = 900000;
  const ok = async (method, path, params = {}) => {
    assertWriteAllowed(method, path, params);
    if (/\/(campaigns|adsets|ads|adcreatives|leadgen_forms|customaudiences|advideos)$/.test(path)) return { id: String(n++) };
    if (path.endsWith('/adimages')) return { images: { demo: { hash: `demo${n++}`, url: 'https://placehold.co/1080x1350' } } };
    if (path.endsWith('/delivery_estimate')) return { data: [{ estimate_mau_lower_bound: 90000, estimate_mau_upper_bound: 140000 }] };
    return method === 'GET' ? { data: [] } : { success: true };
  };
  return { upload: async (p, f) => { assertWriteAllowed('POST', p, f); return { id: String(n++) }; }, get: (p, q) => ok('GET', p, q), post: (p, q) => ok('POST', p, q), del: (p, q) => ok('DELETE', p, q), getAll: async () => [], batch: async () => [], asyncInsights: async () => [] };
}
export const isDemoAccount = (a) => String(a?.meta_account_id || '').startsWith('act_demo');

export async function graphForAdAccount(adAccount, opts) {
  if (isDemoAccount(adAccount)) return demoGraph();
  const token = await tokenForAdAccount(adAccount, opts);
  return createGraphClient({ token, throttleKey: adAccount.meta_account_id });
}
