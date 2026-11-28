import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from './db.js';
import { AppError, forbidden } from './errors.js';

// Roles (spec): owner > manager (launch/budget) > viewer (read only).
// A user can have a membership in many orgs: in agency mode, Wayne staff get a
// separate membership (and role) for each client org.
const RANK = { viewer: 1, manager: 2, owner: 3 };

export function signUserToken(user) {
  return jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: '7d', issuer: 'wayne-ads' });
}

export function requireAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new AppError(401, 'unauthorized', 'Login karein'));
  try {
    const p = jwt.verify(token, config.jwtSecret, { issuer: 'wayne-ads' });
    req.user = { id: Number(p.sub) };
    return next();
  } catch {
    return next(new AppError(401, 'unauthorized', 'Session khatam, dobara login karein'));
  }
}

/** Resolves :orgId from the route and checks the user's membership + role. */
export const requireOrg = (min = 'viewer') => async (req, _res, next) => {
  try {
    const orgId = Number(req.params.orgId);
    if (!orgId) return next(new AppError(400, 'bad_request', 'orgId missing'));
    const { rows } = await query(
      'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
      [req.user.id, orgId],
    );
    if (!rows[0]) return next(forbidden('Is business ka access nahi hai'));
    if ((RANK[rows[0].role] || 0) < RANK[min]) return next(forbidden());
    req.org = { id: orgId, role: rows[0].role };
    return next();
  } catch (e) { return next(e); }
};

export const roleAtLeast = (role, min) => (RANK[role] || 0) >= RANK[min];

/**
 * Super admin = a member of an agency org (Wayne team). Only they see the
 * client list and add clients. A client's own users (owner/manager/viewer of
 * their business) only ever see their own business panel.
 */
export async function isAgencyMember(userId) {
  const { rows } = await query(
    "SELECT 1 FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 AND o.type = 'agency' LIMIT 1", [userId]);
  return Boolean(rows[0]);
}

export async function requireAgency(req, _res, next) {
  try {
    if (!(await isAgencyMember(req.user.id))) return next(forbidden('Ye page sirf Wayne team ke liye hai'));
    return next();
  } catch (e) { return next(e); }
}
