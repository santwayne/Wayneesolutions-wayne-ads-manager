import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { ah, parse } from '../routes/util.js';

/**
 * OAuth 2.1 authorization server for the MCP connector (Claude Directory rule: OAuth per user).
 * Plugs into the MCP SDK's mcpAuthRouter (metadata, /authorize, /token, /register, /revoke).
 * Consent screen lives in the React app (/oauth/consent) so users log in with their normal
 * Wayne Ads account. Codes/tokens are stored hashed.
 */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = () => crypto.randomBytes(32).toString('base64url');
export const MCP_SCOPES = ['ads.read', 'ads.write'];

async function invalidGrant(msg) { const { InvalidGrantError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js'); return new InvalidGrantError(msg); }

export const clientsStore = {
  async getClient(clientId) {
    const { rows: [c] } = await query('SELECT data FROM oauth_clients WHERE client_id = $1', [clientId]);
    return c?.data;
  },
  async registerClient(client) {
    const full = { ...client, client_id: client.client_id || `mcp_${crypto.randomUUID()}`, client_id_issued_at: client.client_id_issued_at || Math.floor(Date.now() / 1000) };
    await query('INSERT INTO oauth_clients (client_id, data) VALUES ($1,$2)', [full.client_id, JSON.stringify(full)]);
    return full;
  },
};

async function issueTokens(clientId, userId, scopes, resource) {
  const access = rand(); const refresh = rand();
  const aExp = new Date(Date.now() + config.mcp.accessTtlSec * 1000);
  const rExp = new Date(Date.now() + config.mcp.refreshTtlSec * 1000);
  await query('INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$9,$3,$4,$5,$6,$10)',
    [sha(access), 'access', clientId, userId, scopes, resource || null, aExp, sha(refresh), 'refresh', rExp]);
  return { access_token: access, token_type: 'bearer', expires_in: config.mcp.accessTtlSec, refresh_token: refresh, scope: scopes.join(' ') };
}

export const oauthProvider = {
  get clientsStore() { return clientsStore; },

  // Hand off to the app's consent page with a signed, short-lived request.
  async authorize(client, params, res) {
    const reqToken = jwt.sign({
      cid: client.client_id, cn: client.client_name || 'Claude', ru: params.redirectUri, cc: params.codeChallenge,
      st: params.state, sc: (params.scopes?.length ? params.scopes : MCP_SCOPES).filter((s) => MCP_SCOPES.includes(s)),
      rs: params.resource?.toString(),
    }, config.jwtSecret, { expiresIn: '10m', audience: 'mcp-consent' });
    res.redirect(302, `${config.appUrl}/oauth/consent?req=${encodeURIComponent(reqToken)}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const { rows: [c] } = await query('SELECT code_challenge FROM oauth_codes WHERE code_hash = $1 AND client_id = $2', [sha(code), client.client_id]);
    if (!c) throw await invalidGrant('Invalid authorization code');
    return c.code_challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const { rows: [c] } = await query(
      'UPDATE oauth_codes SET used = true WHERE code_hash = $1 AND client_id = $2 AND NOT used AND expires_at > now() RETURNING *', [sha(code), client.client_id]);
    if (!c) throw await invalidGrant('Code invalid, expired or already used');
    if (redirectUri && redirectUri !== c.redirect_uri) throw await invalidGrant('redirect_uri mismatch');
    return issueTokens(client.client_id, c.user_id, c.scopes, c.resource);
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const { rows: [t] } = await query(
      "UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND NOT revoked AND expires_at > now() RETURNING *",
      [sha(refreshToken), client.client_id]);
    if (!t) throw await invalidGrant('Refresh token invalid');
    const granted = scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes;
    return issueTokens(client.client_id, t.user_id, granted, t.resource);
  },

  async verifyAccessToken(token) {
    const { rows: [t] } = await query("SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access' AND NOT revoked AND expires_at > now()", [sha(token)]);
    if (!t) { const { InvalidTokenError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js'); throw new InvalidTokenError('Token invalid or expired'); }
    return { token, clientId: t.client_id, scopes: t.scopes, expiresAt: Math.floor(new Date(t.expires_at).getTime() / 1000), extra: { userId: Number(t.user_id) } };
  },

  async revokeToken(client, { token }) {
    await query('UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1 AND client_id = $2', [sha(token), client.client_id]);
  },
};

/** Called by the consent page (logged-in user clicks "Allow"). */
export const oauthConsent = Router();
oauthConsent.get('/oauth/request', ah(async (req, res) => {
  let p; try { p = jwt.verify(String(req.query.req || ''), config.jwtSecret, { audience: 'mcp-consent' }); } catch { throw new AppError(400, 'bad_request', 'Request expire ho gaya'); }
  res.json({ clientName: p.cn, scopes: p.sc });
}));
oauthConsent.post('/oauth/approve', ah(async (req, res) => {
  const { req: reqToken, approve } = parse(z.object({ req: z.string(), approve: z.boolean() }), req.body);
  let p; try { p = jwt.verify(reqToken, config.jwtSecret, { audience: 'mcp-consent' }); } catch { throw new AppError(400, 'bad_request', 'Request expire ho gaya'); }
  const u = new URL(p.ru);
  if (p.st) u.searchParams.set('state', p.st);
  if (!approve) { u.searchParams.set('error', 'access_denied'); return res.json({ redirect: u.toString() }); }
  const code = rand();
  await query('INSERT INTO oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval \'10 minutes\')',
    [sha(code), p.cid, req.user.id, p.cc, p.ru, p.sc, p.rs || null]);
  u.searchParams.set('code', code);
  res.json({ redirect: u.toString() });
}));
