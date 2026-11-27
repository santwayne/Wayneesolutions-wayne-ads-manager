import { config } from '../config.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { conflict, notFound } from '../lib/errors.js';
import { evaluate } from './engine.js';
import { changeBudget, setStatus, logAction } from '../actions/service.js';
import { notifyOwner } from '../notify/whatsapp.js';
import { rewriteRejected, generateCopy } from '../ai/service.js';

const AUTO_TYPES = new Set(['pause', 'budget']);

export async function buildSnapshot(adAccount, now = new Date()) {
  const orgId = adAccount.org_id;
  const [{ rows: org }, { rows: camps }, { rows: sets }, { rows: ads }] = await Promise.all([
    query('SELECT * FROM orgs WHERE id = $1', [orgId]),
    query('SELECT * FROM campaigns WHERE ad_account_id = $1', [adAccount.id]),
    query('SELECT s.*, c.meta_id AS campaign_meta_id, c.launched_at FROM adsets s JOIN campaigns c ON c.id = s.campaign_id WHERE c.ad_account_id = $1', [adAccount.id]),
    query(`SELECT a.*, s.meta_id AS adset_meta_id FROM ads a JOIN adsets s ON s.id = a.adset_id JOIN campaigns c ON c.id = s.campaign_id WHERE c.ad_account_id = $1`, [adAccount.id]),
  ]);
  const ids = [...camps.map((c) => c.meta_id), ...sets.map((s) => s.meta_id), ...ads.map((a) => a.meta_id), adAccount.meta_account_id];
  const { rows: ins } = await query(
    "SELECT * FROM insights_daily WHERE object_id = ANY($1) AND date >= (CURRENT_DATE - INTERVAL '30 days')", [ids]);
  const byObj = new Map();
  for (const r of ins) { if (!byObj.has(r.object_id)) byObj.set(r.object_id, []); byObj.get(r.object_id).push({ ...r, date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date }); }
  const { rows: lifetime } = await query(
    "SELECT object_id, SUM(spend) AS spend, SUM(leads) AS leads FROM insights_daily WHERE level = 'ad' AND object_id = ANY($1) GROUP BY object_id", [ads.map((a) => a.meta_id)]);
  const life = new Map(lifetime.map((r) => [r.object_id, r]));

  const acc30 = byObj.get(adAccount.meta_account_id) || [];
  const s30 = acc30.reduce((a, r) => a + Number(r.spend), 0); const l30 = acc30.reduce((a, r) => a + Number(r.leads), 0);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10);
  const imp = (id, d) => (byObj.get(id) || []).find((r) => r.date === d)?.impressions || 0;

  const { rows: awaiting } = await query(
    `SELECT id, name, EXTRACT(EPOCH FROM (now() - created_at))/60 AS minutes FROM leads
     WHERE org_id = $1 AND page_id = $2 AND status = 'new' AND first_contact_at IS NULL AND NOT out_of_area
       AND created_at > now() - INTERVAL '1 day'`, [orgId, adAccount.page_id]);
  const { rows: [oa] } = await query(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE out_of_area) AS out FROM leads WHERE org_id = $1 AND page_id = $2 AND created_at > now() - INTERVAL '7 days'",
    [orgId, adAccount.page_id]);
  let wallet = null;
  if (org[0].payment_model === 'B') {
    const { rows: [w] } = await query('SELECT * FROM wallets WHERE org_id = $1', [orgId]);
    if (w) wallet = { balance: Number(w.balance), threshold: Number(w.low_balance_threshold), avgDailySpend: s30 / 30 };
  }

  return {
    now, accountMetaId: adAccount.meta_account_id,
    targetCpl: adAccount.target_cpl ? Number(adAccount.target_cpl) : null,
    accountAvgCpl: l30 > 0 ? s30 / l30 : null,
    campaigns: camps.map((c) => ({
      metaId: c.meta_id, name: c.name, status: c.status, objective: c.objective, launchedAt: c.launched_at,
      destination: sets.find((s) => s.campaign_id === c.id)?.destination_type || null,
      todayImpressions: imp(c.meta_id, today), yesterdayImpressions: imp(c.meta_id, yesterday),
      pixelLastFiredAt: adAccount.pixel_last_fired_at,
    })),
    adsets: sets.map((s) => ({
      metaId: s.meta_id, campaignMetaId: s.campaign_meta_id, name: s.name, status: s.status, dailyBudget: Number(s.daily_budget || 0),
      learningStage: s.learning_stage, daysSinceLaunch: s.launched_at ? (now - new Date(s.launched_at)) / 86400_000 : null,
      days: byObj.get(s.meta_id) || [],
    })),
    ads: ads.map((a) => ({
      metaId: a.meta_id, adsetMetaId: a.adset_meta_id, name: a.name, status: a.status, effectiveStatus: a.effective_status,
      reviewFeedback: a.review_feedback, lifetimeSpend: Number(life.get(a.meta_id)?.spend || 0), lifetimeLeads: Number(life.get(a.meta_id)?.leads || 0),
      days: byObj.get(a.meta_id) || [],
    })),
    leadsAwaiting: awaiting.map((l) => ({ id: l.id, name: l.name, minutesWaiting: Math.floor(Number(l.minutes)) })),
    outOfArea: { total: Number(oa.total), outOfArea: Number(oa.out) },
    wallet,
    org: org[0],
  };
}

async function overridesFor(orgId) {
  const { rows } = await query('SELECT rule_type, enabled, threshold FROM rules WHERE org_id = $1', [orgId]);
  return Object.fromEntries(rows.map((r) => [r.rule_type, { ...r.threshold, enabled: r.enabled }]));
}

async function autoActionsToday(orgId) {
  const { rows } = await query("SELECT COUNT(*) AS n FROM actions_log WHERE org_id = $1 AND source = 'rule' AND created_at > date_trunc('day', now())", [orgId]);
  return Number(rows[0].n);
}

async function enrich(f, adAccount) {
  try {
    if (f.ruleType === 'ad_rejected') {
      const { rows } = await query('SELECT c.primary_text FROM ads a JOIN creatives c ON c.id = a.creative_id WHERE a.meta_id = $1', [f.objectId]);
      if (rows[0]?.primary_text) {
        const r = await rewriteRejected({ sector: adAccount.sector_template, text: rows[0].primary_text, reason: f.suggestedAction.reason });
        f.suggestedAction.newText = r.primaryText;
      }
    }
    if (f.ruleType === 'creative_fatigue') {
      const r = await generateCopy({ sector: adAccount.sector_template, offer: 'current offer', businessName: adAccount.name });
      f.suggestedAction.drafts = r.primaryTexts.slice(0, 3);
    }
  } catch (e) { logger.warn({ err: e.message }, 'alert AI enrich failed'); }
  return f;
}

/** Hourly. Returns created alerts. */
export async function runRulesForAccount(adAccount, { only } = {}) {
  const snapshot = await buildSnapshot(adAccount);
  let findings = evaluate(snapshot, await overridesFor(adAccount.org_id));
  if (only) findings = findings.filter((f) => only.includes(f.ruleType));
  const org = snapshot.org;
  const created = [];
  for (const raw of findings) {
    const f = await enrich(raw, adAccount);
    const dryRun = config.rules.dryRun;
    const ins = await query(
      `INSERT INTO alerts (org_id, rule_type, level, object_id, severity, message, suggested_action, status, dedupe_key, dry_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
      [org.id, f.ruleType, f.level, f.objectId, f.severity, f.message, f.suggestedAction ? JSON.stringify(f.suggestedAction) : null,
        dryRun ? 'dry_run' : 'open', f.dedupeKey, dryRun],
    );
    const alert = ins.rows[0];
    if (!alert) continue; // already open
    await query('INSERT INTO rules (org_id, rule_type, last_fired) VALUES ($1,$2,now()) ON CONFLICT (org_id, rule_type) DO UPDATE SET last_fired = now()', [org.id, f.ruleType]);
    created.push(alert);
    if (dryRun) continue; // dry run: log suggestions only — no WhatsApp, no actions

    const action = f.suggestedAction;
    const autoOk = org.auto_mode && action && AUTO_TYPES.has(action.type) && (await autoActionsToday(org.id)) < org.auto_daily_action_limit;
    if (autoOk) {
      try {
        await executeAction(org.id, action, { who: `rule:${f.ruleType}`, source: 'rule' });
        await query("UPDATE alerts SET status = 'auto_applied', action_taken = $2, resolved_at = now() WHERE id = $1", [alert.id, action.type]);
        await notifyOwner(org.id, `🤖 Auto-mode: ${f.message}\n✅ Kar diya. Wapas karna ho toh app mein "Undo" dabayein.`);
        continue;
      } catch (e) { logger.warn({ err: e.message }, 'auto action refused, asking owner'); }
    }
    const buttons = action && ['pause', 'budget'].includes(action.type)
      ? [{ id: `alert:${alert.id}:yes`, title: 'Haan' }, { id: `alert:${alert.id}:no`, title: 'Na' }]
      : null;
    await notifyOwner(org.id, `${f.severity === 'critical' ? '🚨' : '⚠️'} ${f.message}`, buttons);
  }
  return created;
}

export async function executeAction(orgId, action, actor) {
  if (action.type === 'pause') return setStatus({ orgId, level: action.level, metaId: action.metaId, status: 'PAUSED', actor });
  if (action.type === 'budget') return changeBudget({ orgId, adsetMetaId: action.metaId, dailyBudget: action.to, actor });
  throw conflict('Is suggestion pe automatic action nahi hota');
}

/** Owner says Haan/Na (app or WhatsApp). */
export async function decideAlert(orgId, alertId, approve, actor) {
  const { rows } = await query('SELECT * FROM alerts WHERE id = $1 AND org_id = $2', [alertId, orgId]);
  const alert = rows[0];
  if (!alert) throw notFound('Alert nahi mila');
  if (alert.status !== 'open') throw conflict('Is alert pe pehle hi faisla ho chuka hai');
  if (!approve) {
    await query("UPDATE alerts SET status = 'rejected', approved_by = $2, resolved_at = now() WHERE id = $1", [alertId, actor.who]);
    await logAction({ orgId, who: actor.who, source: actor.source, what: 'reject_suggestion', level: alert.level, objectId: alert.object_id, before: { alert: alert.rule_type } });
    return { status: 'rejected' };
  }
  const res = alert.suggested_action ? await executeAction(orgId, alert.suggested_action, actor) : null;
  await query("UPDATE alerts SET status = 'approved', approved_by = $2, action_taken = $3, resolved_at = now() WHERE id = $1",
    [alertId, actor.who, alert.suggested_action?.type || null]);
  return { status: 'approved', result: res };
}
