import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { requireOrg, requireAuth } from '../lib/auth.js';
import { ah } from './util.js';
import { storeConnection } from '../meta/tokens.js';
import { createGraphClient } from '../meta/graph.js';
import { badRequest } from '../lib/errors.js';

/**
 * Phase 2 self-serve: Facebook Login for Business (with configuration ID).
 * Flow: app -> GET /orgs/:orgId/meta/login-url -> Facebook -> /meta/callback?code&state
 * -> exchange code -> long-lived token -> encrypted (KMS) in meta_connections.
 */
export const metaLogin = Router();

metaLogin.get('/orgs/:orgId/meta/login-url', requireAuth, requireOrg('owner'), (req, res) => {
  const state = jwt.sign({ org: req.org.id, u: req.user.id }, config.jwtSecret, { expiresIn: '10m' });
  const u = new URL(`https://www.facebook.com/${config.meta.apiVersion}/dialog/oauth`);
  u.searchParams.set('client_id', config.meta.appId);
  u.searchParams.set('redirect_uri', `${config.publicBaseUrl}/meta/callback`);
  u.searchParams.set('config_id', config.meta.loginConfigId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  res.json({ url: u.toString() });
});

metaLogin.get('/meta/callback', ah(async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state || ''), config.jwtSecret); } catch { throw badRequest('Login link expire ho gaya, dobara try karein'); }
  const appToken = `${config.meta.appId}|${config.meta.appSecret}`;
  const g = createGraphClient({ token: appToken });
  const short = await g.get('oauth/access_token', { client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: `${config.publicBaseUrl}/meta/callback`, code: String(req.query.code || '') });
  const long = await g.get('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: config.meta.appId, client_secret: config.meta.appSecret, fb_exchange_token: short.access_token });
  const me = await createGraphClient({ token: long.access_token }).get('me', { fields: 'id' });
  const perms = await createGraphClient({ token: long.access_token }).get('me/permissions');
  await storeConnection({
    orgId: st.org, kind: 'user', token: long.access_token, metaUserId: me.id,
    scopes: (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission),
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
  });
  res.redirect(`${config.appUrl}/orgs/${st.org}/settings?meta=connected`);
}));
