import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireOrg } from '../lib/auth.js';
import { ah, parse, actorOf } from './util.js';
import { setStatus, changeBudget, undoLast } from '../actions/service.js';
import { decideAlert } from '../rules/runner.js';
import { DEFAULTS } from '../rules/engine.js';
import { getTemplate } from '../wizard/templates/index.js';
import { topUp } from '../wallet/service.js';
import { forbidden } from '../lib/errors.js';

export const ops = Router();

// ---- Actions (manager+) ----
ops.post('/orgs/:orgId/objects/:level/:metaId/status', requireOrg('manager'), ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }), req.body);
  res.json(await setStatus({ orgId: req.org.id, level: req.params.level, metaId: req.params.metaId, status, actor: actorOf(req) }));
}));

ops.post('/orgs/:orgId/adsets/:metaId/budget', requireOrg('manager'), ah(async (req, res) => {
  const { dailyBudget } = parse(z.object({ dailyBudget: z.number().positive() }), req.body);
  res.json(await changeBudget({ orgId: req.org.id, adsetMetaId: req.params.metaId, dailyBudget, actor: actorOf(req) }));
}));

// Owner: one-click undo of the last change.
ops.post('/orgs/:orgId/undo', requireOrg('owner'), ah(async (req, res) => res.json(await undoLast({ orgId: req.org.id, actor: actorOf(req) }))));

ops.get('/orgs/:orgId/actions-log', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM actions_log WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [req.org.id]);
  res.json(rows);
}));

// ---- Alerts ----
ops.get('/orgs/:orgId/alerts', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM alerts WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 200', [req.org.id, req.query.status || null]);
  res.json(rows);
}));

ops.post('/orgs/:orgId/alerts/:id/decision', requireOrg('manager'), ah(async (req, res) => {
  const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
  res.json(await decideAlert(req.org.id, Number(req.params.id), approve, actorOf(req)));
}));

// ---- Rule thresholds (configurable per account/org) ----
ops.get('/orgs/:orgId/rules', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM rules WHERE org_id = $1', [req.org.id]);
  const by = Object.fromEntries(rows.map((r) => [r.rule_type, r]));
  const { rows: [acc] } = await query('SELECT sector_template FROM ad_accounts WHERE org_id = $1 ORDER BY id LIMIT 1', [req.org.id]);
  const tpl = getTemplate(acc?.sector_template).rules || {};
  res.json(Object.entries(DEFAULTS).map(([type, def]) => ({
    ruleType: type, enabled: by[type]?.enabled ?? def.enabled,
    threshold: { ...def, ...(tpl[type] || {}), ...(by[type]?.threshold || {}) },
    templateDefaults: tpl[type] || null, lastFired: by[type]?.last_fired || null,
  })));
}));

ops.put('/orgs/:orgId/rules/:type', requireOrg('owner'), ah(async (req, res) => {
  if (!DEFAULTS[req.params.type]) return res.status(404).json({ error: 'unknown rule' });
  const b = parse(z.object({ enabled: z.boolean().default(true), threshold: z.record(z.number()).default({}) }), req.body);
  if (req.params.type === 'winner' && b.threshold.budgetStepPct > 20) b.threshold.budgetStepPct = 20; // hard cap
  const { rows: [r] } = await query(
    `INSERT INTO rules (org_id, rule_type, enabled, threshold) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, rule_type) DO UPDATE SET enabled = EXCLUDED.enabled, threshold = EXCLUDED.threshold RETURNING *`,
    [req.org.id, req.params.type, b.enabled, b.threshold]);
  res.json(r);
}));

ops.get('/orgs/:orgId/recommendations', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM recommendations WHERE org_id = $1 ORDER BY week_start DESC LIMIT 8', [req.org.id]);
  res.json(rows);
}));

// ---- Wallet (Model B) ----
ops.get('/orgs/:orgId/wallet', requireOrg('viewer'), ah(async (req, res) => {
  const { rows: [w] } = await query('SELECT * FROM wallets WHERE org_id = $1', [req.org.id]);
  const { rows: ledger } = await query('SELECT * FROM wallet_ledger WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [req.org.id]);
  const { rows: invoices } = await query('SELECT * FROM invoices WHERE org_id = $1 ORDER BY month DESC', [req.org.id]);
  res.json({ wallet: w || null, ledger, invoices });
}));

// Phase 1: top-ups recorded by Wayne staff after payment is received (Razorpay later).
ops.post('/orgs/:orgId/wallet/topup', requireOrg('manager'), ah(async (req, res) => {
  const { rows: [o] } = await query('SELECT parent_agency_id, payment_model FROM orgs WHERE id = $1', [req.org.id]);
  if (o.payment_model !== 'B') throw forbidden('Ye client Model A (apna card) pe hai');
  const { rows: m } = await query('SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2', [req.user.id, o.parent_agency_id]);
  if (!m[0]) throw forbidden('Top-up sirf Wayne team record kar sakti hai');
  const b = parse(z.object({ amount: z.number().positive(), ref: z.string().min(3) }), req.body);
  res.json(await topUp(req.org.id, b.amount, { ref: b.ref, actor: actorOf(req) }));
}));
