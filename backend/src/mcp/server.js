import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { roleAtLeast } from '../lib/auth.js';
import { totals, objectPerformance } from '../reports/metrics.js';
import { setStatus, changeBudget, launchCampaign } from '../actions/service.js';
import { createDraft, updateDraft, validate } from '../wizard/service.js';
import { generateCopy } from '../ai/service.js';
import { GOALS } from '../wizard/goals.js';
import { TEMPLATES } from '../wizard/templates/index.js';
import { logger } from '../lib/logger.js';

/**
 * Wayne Ads MCP connector (Phase 2). Claude Directory rules applied:
 *  - read and write tools are separate; every tool has a title + annotations
 *  - destructive writes (pause/resume/budget/launch) are marked destructiveHint so the
 *    client asks the user to confirm every time; the same money-safety layer as the app applies
 *  - clear errors (isError + Hinglish/English message), OAuth per user, org access per membership
 *  - no AI image/video generation tools
 */
class ToolError extends Error {}
const ok = (data, text) => ({ content: [{ type: 'text', text: text || JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

async function roleIn(userId, orgId, min) {
  const { rows: [m] } = await query('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [userId, orgId]);
  if (!m) throw new ToolError(`No access to business ${orgId}. Use list_accounts to see your businesses.`);
  if (!roleAtLeast(m.role, min)) throw new ToolError(`Your role (${m.role}) cannot do this; needs ${min}.`);
  return m.role;
}

function wrap(fn) {
  return async (args, extra) => {
    try {
      const userId = extra.authInfo?.extra?.userId;
      if (!userId) return fail('Not signed in.');
      return await fn(args, { userId, scopes: extra.authInfo.scopes || [] });
    } catch (e) {
      if (!(e instanceof ToolError)) logger.warn({ err: e.message }, 'mcp tool error');
      return fail(e.message || 'Something went wrong');
    }
  };
}
const needWrite = (ctx) => { if (!ctx.scopes.includes('ads.write')) throw new ToolError('This connection is read-only (ads.write scope not granted). Reconnect and allow changes.'); };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const orgId = z.number().int().describe('Business id from list_accounts');

export function buildMcpServer() {
  const s = new McpServer({ name: 'wayne-ads-manager', version: '0.2.0' });

  s.registerTool('list_accounts', {
    title: 'List businesses and ad accounts',
    description: 'Lists the businesses you can access in Wayne Ads Manager, with their Meta ad accounts and your role.',
    inputSchema: {}, annotations: READ,
  }, wrap(async (_a, ctx) => {
    const { rows } = await query(
      `SELECT o.id, o.name, m.role, o.payment_model,
         COALESCE(json_agg(json_build_object('adAccountId', a.id, 'metaAccountId', a.meta_account_id, 'sector', a.sector_template, 'targetCpl', a.target_cpl)) FILTER (WHERE a.id IS NOT NULL), '[]') AS ad_accounts
       FROM memberships m JOIN orgs o ON o.id = m.org_id LEFT JOIN ad_accounts a ON a.org_id = o.id
       WHERE m.user_id = $1 AND o.type = 'business' GROUP BY o.id, m.role ORDER BY o.name`, [ctx.userId]);
    return ok({ businesses: rows });
  }));

  s.registerTool('get_performance', {
    title: 'Get ad performance',
    description: 'Spend, leads, cost per lead, customers won (CRM) and cost per customer for a business, plus per-campaign numbers. Amounts in INR.',
    inputSchema: { orgId, days: z.number().int().min(1).max(90).default(7) }, annotations: READ,
  }, wrap(async ({ orgId: id, days }, ctx) => {
    await roleIn(ctx.userId, id, 'viewer');
    return ok({ days, totals: await totals(id, { days }), campaigns: await objectPerformance(id, 'campaign', days) });
  }));

  s.registerTool('get_campaign', {
    title: 'Get one campaign',
    description: 'A campaign with its ad sets (budget, learning status) and ads (spend, leads, CPL, frequency, review status).',
    inputSchema: { orgId, campaignId: z.string().describe('Meta campaign id'), days: z.number().int().min(1).max(90).default(7) }, annotations: READ,
  }, wrap(async ({ orgId: id, campaignId, days }, ctx) => {
    await roleIn(ctx.userId, id, 'viewer');
    const { rows: [c] } = await query('SELECT id, meta_id, name, status, objective, launched_at FROM campaigns WHERE org_id = $1 AND meta_id = $2', [id, campaignId]);
    if (!c) throw new ToolError('Campaign not found');
    const { rows: sets } = await query('SELECT meta_id, name, status, daily_budget, learning_stage, optimization_goal FROM adsets WHERE campaign_id = $1', [c.id]);
    const ads = await objectPerformance(id, 'ad', days);
    const { rows: adIds } = await query('SELECT a.meta_id FROM ads a JOIN adsets s ON s.id = a.adset_id WHERE s.campaign_id = $1', [c.id]);
    const set = new Set(adIds.map((r) => r.meta_id));
    return ok({ campaign: c, adsets: sets, ads: ads.filter((a) => set.has(a.objectId)) });
  }));

  s.registerTool('list_alerts', {
    title: 'List alerts',
    description: 'Open alerts from the rules engine (money burning, expensive ad, winner, creative fatigue, delivery stopped, rejected ad, tracking broken, lead follow-up, out-of-area, wallet).',
    inputSchema: { orgId, status: z.enum(['open', 'approved', 'rejected', 'auto_applied', 'dry_run']).default('open') }, annotations: READ,
  }, wrap(async ({ orgId: id, status }, ctx) => {
    await roleIn(ctx.userId, id, 'viewer');
    const { rows } = await query('SELECT id, rule_type, severity, message, suggested_action, status, created_at FROM alerts WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 50', [id, status]);
    return ok({ alerts: rows });
  }));

  s.registerTool('get_recommendations', {
    title: 'Get weekly AI recommendations',
    description: "This week's 3 recommended actions (what to stop, where to scale, what to test) and new ad copy ideas.",
    inputSchema: { orgId }, annotations: READ,
  }, wrap(async ({ orgId: id }, ctx) => {
    await roleIn(ctx.userId, id, 'viewer');
    const { rows: [r] } = await query('SELECT week_start, payload FROM recommendations WHERE org_id = $1 ORDER BY week_start DESC LIMIT 1', [id]);
    return ok(r || { message: 'No recommendations yet (generated every Monday).' });
  }));

  s.registerTool('create_campaign_draft', {
    title: 'Create campaign draft (always paused)',
    description: 'Creates a campaign draft in Wayne Ads Manager using the sector template and policy-checked AI copy. Nothing goes live: photos/videos are added in the app, then it is created PAUSED on Meta, and only launch_campaign or the owner can make it live. Returns the checklist of anything missing.',
    inputSchema: {
      orgId, adAccountId: z.number().int(),
      goal: z.enum(Object.keys(GOALS)).describe('lead_form | whatsapp | call | website | store_visit'),
      sector: z.enum(Object.keys(TEMPLATES)).optional(),
      latitude: z.number(), longitude: z.number(), radiusKm: z.number().min(1).max(80).optional(),
      dailyBudget: z.number().positive().describe('INR per day'),
      offer: z.string().min(3), language: z.enum(['hinglish', 'english', 'punjabi']).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, wrap(async (a, ctx) => {
    needWrite(ctx);
    await roleIn(ctx.userId, a.orgId, 'manager');
    const draft = await createDraft(a.orgId, { adAccountId: a.adAccountId, channel: 'app', data: {} });
    const data = { goal: a.goal, location: { lat: a.latitude, lng: a.longitude }, dailyBudget: a.dailyBudget, offer: a.offer, maxDailyBudget: a.dailyBudget };
    if (a.sector) data.sector = a.sector;
    if (a.radiusKm) data.radiusKm = a.radiusKm;
    if (a.language) data.language = a.language;
    const d1 = await updateDraft(a.orgId, draft.id, data);
    const copy = await generateCopy({ sector: d1.data.sector, offer: a.offer, language: a.language, goal: a.goal });
    await updateDraft(a.orgId, draft.id, { primaryTexts: copy.primaryTexts.slice(0, 3), headlines: copy.headlines.slice(0, 3) });
    const v = await validate(a.orgId, draft.id, { withReach: false, maxDailyBudget: a.dailyBudget });
    return ok({
      draftId: draft.id, status: 'draft (nothing on Meta yet)', openInApp: `${config.appUrl}/orgs/${a.orgId}/new?draft=${draft.id}`,
      settings: v.draft, adText: copy, checklist: v.checks.map((c) => ({ level: c.level, message: c.message, fix: c.fix })),
    });
  }));

  const W = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  s.registerTool('pause_ad', {
    title: 'Pause an ad', description: 'Pauses one ad on Meta. Logged and undoable from the app. Ask the user to confirm first.',
    inputSchema: { orgId, adId: z.string().describe('Meta ad id') }, annotations: W,
  }, wrap(async ({ orgId: id, adId }, ctx) => {
    needWrite(ctx); await roleIn(ctx.userId, id, 'manager');
    const r = await setStatus({ orgId: id, level: 'ad', metaId: adId, status: 'PAUSED', actor: { who: `mcp:user:${ctx.userId}`, source: 'mcp' } });
    return ok({ adId, status: 'PAUSED', unchanged: !!r.unchanged });
  }));

  s.registerTool('resume_ad', {
    title: 'Resume an ad', description: 'Resumes a paused ad on Meta (starts spending again). Ask the user to confirm first.',
    inputSchema: { orgId, adId: z.string() }, annotations: W,
  }, wrap(async ({ orgId: id, adId }, ctx) => {
    needWrite(ctx); await roleIn(ctx.userId, id, 'manager');
    const r = await setStatus({ orgId: id, level: 'ad', metaId: adId, status: 'ACTIVE', actor: { who: `mcp:user:${ctx.userId}`, source: 'mcp' } });
    return ok({ adId, status: 'ACTIVE', unchanged: !!r.unchanged });
  }));

  s.registerTool('change_budget', {
    title: 'Change ad set daily budget',
    description: "Changes an ad set's daily budget (INR). Safety rules: an increase of max 20% per change, never above the owner's daily cap. Ask the user to confirm first.",
    inputSchema: { orgId, adsetId: z.string(), dailyBudget: z.number().positive() }, annotations: { ...W, idempotentHint: false },
  }, wrap(async ({ orgId: id, adsetId, dailyBudget }, ctx) => {
    needWrite(ctx); await roleIn(ctx.userId, id, 'manager');
    const r = await changeBudget({ orgId: id, adsetMetaId: adsetId, dailyBudget, actor: { who: `mcp:user:${ctx.userId}`, source: 'mcp' } });
    return ok({ adsetId, dailyBudget, before: r.log?.before?.daily_budget ?? null, unchanged: !!r.unchanged });
  }));

  s.registerTool('launch_campaign', {
    title: 'Launch a paused campaign',
    description: 'Makes a PAUSED campaign (and its ad set + ads) live on Meta — it will start spending money. Always confirm with the user first. Model B clients need wallet balance.',
    inputSchema: { orgId, campaignId: z.string() }, annotations: { ...W, idempotentHint: false },
  }, wrap(async ({ orgId: id, campaignId }, ctx) => {
    needWrite(ctx); await roleIn(ctx.userId, id, 'manager');
    await launchCampaign({ orgId: id, campaignMetaId: campaignId, actor: { who: `mcp:user:${ctx.userId}`, source: 'mcp' } });
    return ok({ campaignId, status: 'ACTIVE' }, `Campaign ${campaignId} is live. Meta review can take ~1 hour.`);
  }));

  return s;
}

/** Stateless Streamable HTTP: one server+transport per request. */
export async function handleMcp(req, res) {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
