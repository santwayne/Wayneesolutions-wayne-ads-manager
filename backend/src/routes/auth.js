import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { requireAuth, signUserToken } from '../lib/auth.js';
import { ah, parse } from './util.js';

export const auth = Router();

auth.post('/login', ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new AppError(401, 'bad_credentials', 'Email ya password galat hai');
  res.json({ token: signUserToken(u), user: { id: u.id, name: u.name, email: u.email } });
}));

auth.get('/me', requireAuth, ah(async (req, res) => {
  const { rows: [u] } = await query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
  const { rows: orgs } = await query(
    'SELECT o.id, o.name, o.type, o.payment_model, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.type, o.name', [req.user.id]);
  res.json({ user: u, orgs });
}));
