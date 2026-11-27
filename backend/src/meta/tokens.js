import { config } from '../config.js';
import { query } from '../lib/db.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { createGraphClient, MetaApiError } from './graph.js';

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

export async function tokenForAdAccount(adAccount, { onExpired } = {}) {
  if (!adAccount.connection_id) {
    if (!config.meta.systemUserToken) throw new Error('META_SYSTEM_USER_TOKEN not set');
    return config.meta.systemUserToken;
  }
  const { rows } = await query('SELECT * FROM meta_connections WHERE id = $1', [adAccount.connection_id]);
  const conn = rows[0];
  if (!conn || conn.status !== 'active') throw new Error('Meta connection not active — reconnect needed');
  const token = await decryptSecret(conn.token_enc);

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

export async function graphForAdAccount(adAccount, opts) {
  const token = await tokenForAdAccount(adAccount, opts);
  return createGraphClient({ token, throttleKey: adAccount.meta_account_id });
}
