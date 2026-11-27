import { badRequest } from '../lib/errors.js';

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Galat input', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export const actorOf = (req) => ({ who: `user:${req.user.id}`, source: 'user' });
