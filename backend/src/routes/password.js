import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { signUserToken } from '../lib/auth.js';
import { ah, parse } from './util.js';
import { sendEmail, emailConfigured } from '../notify/email.js';
import { sendText } from '../notify/whatsapp.js';
import { logger } from '../lib/logger.js';

/**
 * Forgot password + invite acceptance share one flow: a single-use token (stored hashed)
 * in a link to /reset-password?token=...  Reset links last 1 hour, invites 7 days.
 * The request endpoint always answers the same way so emails can't be probed.
 */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TTL = { reset: 3600_000, invite: 7 * 86400_000 };

export async function issueUserToken(c, { userId, purpose, orgId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  // One live link per user+purpose: older ones stop working.
  await c.query("UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [userId, purpose]);
  await c.query('INSERT INTO user_tokens (token_hash, user_id, purpose, org_id, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [sha(token), userId, purpose, orgId, new Date(Date.now() + TTL[purpose])]);
  return token;
}

export const resetLink = (token, purpose) => `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}${purpose === 'invite' ? '&invite=1' : ''}`;

/** Deliver by email if configured, else WhatsApp to the user's phone. Returns the channel used. */
export async function deliverLink(user, { subject, line, link }) {
  if (emailConfigured() && user.email) {
    const ok = await sendEmail({ to: user.email, subject, text: `${line}\n\n${link}\n\nAgar aapne ye request nahi ki, toh is email ko ignore karein.`, html: `<p>${line}</p><p><a href="${link}">${link}</a></p><p style="color:#667085">Agar aapne ye request nahi ki, toh is email ko ignore karein.</p>` });
    if (ok) return 'email';
  }
  if (user.phone) {
    try { await sendText(null, user.phone.replace(/\D/g, ''), `${line}\n${link}`); return 'whatsapp'; } catch (e) { logger.warn({ err: e.message }, 'whatsapp link failed'); }
  }
  return null;
}

export const password = Router();

password.post('/forgot-password', ah(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  if (u) {
    const token = await tx((c) => issueUserToken(c, { userId: u.id, purpose: 'reset' }));
    await deliverLink(u, { subject: 'Wayne Ads — password reset', line: 'Naya password set karne ke liye ye link kholiye (1 ghante tak valid):', link: resetLink(token, 'reset') });
  }
  res.json({ ok: true, message: 'Agar ye email registered hai, toh reset link bhej diya gaya hai (email ya WhatsApp pe).' });
}));

password.get('/reset-password/check', ah(async (req, res) => {
  const { rows: [t] } = await query(
    `SELECT t.purpose, u.email, u.name, o.name AS org_name FROM user_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN orgs o ON o.id = t.org_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`, [sha(String(req.query.token || ''))]);
  if (!t) throw new AppError(400, 'link_invalid', 'Ye link expire ho gaya hai ya pehle use ho chuka hai. Naya link mangwaiye.');
  res.json({ purpose: t.purpose, email: t.email, name: t.name, orgName: t.org_name });
}));

password.post('/reset-password', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20), password: z.string().min(8).max(200), name: z.string().min(1).optional() }), req.body);
  const user = await tx(async (c) => {
    const { rows: [t] } = await c.query(
      'UPDATE user_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *', [sha(b.token)]);
    if (!t) throw new AppError(400, 'link_invalid', 'Ye link expire ho gaya hai ya pehle use ho chuka hai. Naya link mangwaiye.');
    const { rows: [u] } = await c.query(
      'UPDATE users SET password_hash = $2, password_set = true, name = COALESCE($3, name) WHERE id = $1 RETURNING id, name, email',
      [t.user_id, await bcrypt.hash(b.password, 10), t.purpose === 'invite' ? b.name || null : null]);
    // A reset ends every other open reset link for this user too.
    await c.query("UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL", [t.user_id]);
    return { ...u, orgId: t.org_id };
  });
  res.json({ token: signUserToken(user), user: { id: user.id, name: user.name, email: user.email }, orgId: user.orgId });
}));
