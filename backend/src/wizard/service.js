import { query, tx } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { graphForAdAccount } from '../meta/tokens.js';
import { buildAdSet, buildCampaign, buildCreative, buildLeadForm, buildTargeting, planAds } from '../meta/builder.js';
import { resolveGoal } from './goals.js';
import { getTemplate } from './templates/index.js';
import { validateDraft } from './validate.js';
import { logAction } from '../actions/service.js';

let graphFactory = graphForAdAccount;
export function setWizardGraphFactory(fn) { graphFactory = fn; }

export async function getDraftContext(orgId, draftId) {
  const { rows } = await query('SELECT * FROM wizard_drafts WHERE id = $1 AND org_id = $2', [draftId, orgId]);
  const draft = rows[0];
  if (!draft) throw notFound('Draft nahi mila');
  const [{ rows: accs }, { rows: orgs }] = await Promise.all([
    query('SELECT * FROM ad_accounts WHERE id = $1 AND org_id = $2', [draft.ad_account_id, orgId]),
    query('SELECT * FROM orgs WHERE id = $1', [orgId]),
  ]);
  return { draft, adAccount: accs[0], org: orgs[0] };
}

export async function createDraft(orgId, { adAccountId, channel = 'app', data = {} }) {
  const { rows } = await query('SELECT id, sector_template FROM ad_accounts WHERE id = $1 AND org_id = $2', [adAccountId, orgId]);
  if (!rows[0]) throw notFound('Ad account nahi mila');
  const initial = { sector: rows[0].sector_template || undefined, ...data };
  const r = await query(
    'INSERT INTO wizard_drafts (org_id, ad_account_id, channel, data) VALUES ($1,$2,$3,$4) RETURNING *',
    [orgId, adAccountId, channel, initial],
  );
  return r.rows[0];
}

export async function updateDraft(orgId, draftId, patch) {
  const { rows } = await query(
    `UPDATE wizard_drafts SET data = data || $3::jsonb, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING *`,
    [draftId, orgId, JSON.stringify(patch)],
  );
  if (!rows[0]) throw conflict('Draft edit nahi ho sakta (already created?)');
  return rows[0];
}

/** Meta delivery estimate for the audience-size warning (Screen 3). Best effort. */
export async function reachEstimate(adAccount, draftData) {
  if (!draftData.location?.lat) return null;
  try {
    const t = getTemplate(draftData.sector);
    const v = validateDraft(draftData, { adAccount });
    const g = await graphFactory(adAccount);
    const r = await g.get(`${adAccount.meta_account_id}/delivery_estimate`, {
      targeting_spec: buildTargeting(v.draft, { specialAdCategories: t.specialAdCategories }),
      optimization_goal: v.meta.optimizationGoal,
    });
    const d = r.data?.[0];
    return d ? { lower: d.estimate_mau_lower_bound, upper: d.estimate_mau_upper_bound } : null;
  } catch (e) {
    logger.warn({ err: e.message }, 'delivery estimate failed');
    return null;
  }
}

export async function validate(orgId, draftId, { withReach = true, maxDailyBudget } = {}) {
  const { draft, adAccount, org } = await getDraftContext(orgId, draftId);
  const reach = withReach ? await reachEstimate(adAccount, draft.data) : null;
  return validateDraft(draft.data, { adAccount, org, reachEstimate: reach, maxDailyBudget: maxDailyBudget ?? draft.data.maxDailyBudget });
}

/** Upload media to the ad account (image bytes -> hash; video url -> id). */
export async function uploadMedia(adAccount, item) {
  const g = await graphFactory(adAccount);
  if (item.type === 'image') {
    const r = await g.post(`${adAccount.meta_account_id}/adimages`, { bytes: item.base64 });
    const first = Object.values(r.images || {})[0];
    return { imageHash: first?.hash, url: first?.url };
  }
  if (item.buffer) {
    const r = await g.upload(`${adAccount.meta_account_id}/advideos`, { name: item.name || 'Wayne video' }, { buffer: item.buffer, mimeType: item.mimeType, name: item.name });
    return { videoId: r.id };
  }
  const r = await g.post(`${adAccount.meta_account_id}/advideos`, { file_url: item.fileUrl, name: item.name || 'Wayne video' });
  return { videoId: r.id };
}

/**
 * Screen 7 "Create (paused)". Creates campaign -> (lead form) -> ad set -> creatives -> ads.
 * Everything PAUSED. Already-created ids are stored on the draft so a retry continues
 * instead of creating duplicates.
 */
export async function createOnMeta(orgId, draftId, actor) {
  const { draft, adAccount, org } = await getDraftContext(orgId, draftId);
  if (draft.status !== 'draft') throw conflict('Ye campaign pehle hi ban chuka hai');
  const v = validateDraft(draft.data, { adAccount, org, maxDailyBudget: draft.data.maxDailyBudget });
  if (v.blocking) throw badRequest('Checklist mein laal items theek karo', v.checks.filter((c) => c.level === 'block'));

  const d = v.draft;
  const template = getTemplate(d.sector);
  const goal = resolveGoal(d.goal, { pixelEvent: d.pixelEvent });
  const g = await graphFactory(adAccount);
  const created = { ...(draft.data._created || {}) };
  const save = () => query('UPDATE wizard_drafts SET data = jsonb_set(data, \'{_created}\', $3::jsonb), updated_at = now() WHERE id = $1 AND org_id = $2', [draftId, orgId, JSON.stringify(created)]);

  const { rows: excl } = await query("SELECT meta_id FROM exclusion_audiences WHERE ad_account_id = $1 AND meta_id IS NOT NULL", [adAccount.id]);

  if (!created.campaignId) {
    const c = await g.post(`${adAccount.meta_account_id}/campaigns`, buildCampaign(d, goal, { specialAdCategories: template.specialAdCategories, name: d.name }));
    created.campaignId = c.id; await save();
  }
  if (goal.needsLeadForm && !created.leadFormId) {
    const f = await g.post(`${adAccount.page_id}/leadgen_forms`, buildLeadForm(d, { privacyPolicyUrl: d.privacyPolicyUrl, phone: d.phone, whatsappPhone: adAccount.whatsapp_phone }));
    created.leadFormId = f.id; await save();
  }
  if (!created.adsetId) {
    const targeting = buildTargeting(d, { specialAdCategories: template.specialAdCategories, excludedAudienceIds: excl.map((r) => r.meta_id) });
    const s = await g.post(`${adAccount.meta_account_id}/adsets`, buildAdSet(d, goal, {
      campaignId: created.campaignId, pageId: adAccount.page_id, whatsappPhone: adAccount.whatsapp_phone, pixelId: adAccount.pixel_id, targeting,
    }));
    created.adsetId = s.id; created.targeting = targeting; await save();
  }
  created.ads = created.ads || [];
  const plan = planAds(d, goal);
  for (let i = created.ads.length; i < plan.length; i++) {
    const p = plan[i];
    const cr = await g.post(`${adAccount.meta_account_id}/adcreatives`, buildCreative(d, goal, {
      media: p.media || {}, primaryText: p.primaryText, headline: p.headline, pageId: adAccount.page_id,
      instagramId: adAccount.instagram_id, leadFormId: created.leadFormId, phone: d.phone,
    }));
    const ad = await g.post(`${adAccount.meta_account_id}/ads`, { name: `Wayne ad ${i + 1}`, adset_id: created.adsetId, creative: { creative_id: cr.id }, status: 'PAUSED' });
    created.ads.push({ creativeId: cr.id, adId: ad.id, ...p });
    await save();
  }

  // Mirror into our DB.
  const campaignRowId = await tx(async (c) => {
    const camp = await c.query(
      `INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status, objective, daily_budget, special_ad_categories, created_by_wizard, wizard_draft_id)
       VALUES ($1,$2,$3,$4,'PAUSED',$5,NULL,$6,true,$7)
       ON CONFLICT (meta_id) DO UPDATE SET created_by_wizard = true RETURNING id`,
      [orgId, adAccount.id, created.campaignId, d.name || `Wayne | ${d.sector}`, goal.objective, template.specialAdCategories, draftId],
    );
    const set = await c.query(
      `INSERT INTO adsets (org_id, campaign_id, meta_id, name, status, optimization_goal, destination_type, daily_budget, targeting, created_by_wizard)
       VALUES ($1,$2,$3,$4,'PAUSED',$5,$6,$7,$8,true)
       ON CONFLICT (meta_id) DO UPDATE SET created_by_wizard = true RETURNING id`,
      [orgId, camp.rows[0].id, created.adsetId, `Wayne | ${d.sector}`, goal.optimizationGoal, goal.destinationType, d.dailyBudget, created.targeting],
    );
    for (const [i, a] of created.ads.entries()) {
      const cr = await c.query(
        `INSERT INTO creatives (org_id, ad_account_id, meta_creative_id, type, primary_text, headline, cta, asset_url, image_hash, video_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (meta_creative_id) DO UPDATE SET primary_text = EXCLUDED.primary_text RETURNING id`,
        [orgId, adAccount.id, a.creativeId, a.media?.type || goal.creative, a.primaryText, a.headline, goal.cta, a.media?.url || null, a.media?.imageHash || null, a.media?.videoId || null],
      );
      await c.query(
        `INSERT INTO ads (org_id, adset_id, creative_id, meta_id, name, status, created_by_wizard) VALUES ($1,$2,$3,$4,$5,'PAUSED',true)
         ON CONFLICT (meta_id) DO NOTHING`,
        [orgId, set.rows[0].id, cr.rows[0].id, a.adId, `Wayne ad ${i + 1}`],
      );
    }
    if (created.leadFormId) {
      await c.query('INSERT INTO lead_forms (org_id, page_id, meta_form_id, name) VALUES ($1,$2,$3,$4) ON CONFLICT (meta_form_id) DO NOTHING',
        [orgId, adAccount.page_id, created.leadFormId, `Wayne ${d.sector}`]);
    }
    await c.query("UPDATE wizard_drafts SET status = 'created', campaign_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2", [draftId, orgId, camp.rows[0].id]);
    return camp.rows[0].id;
  });

  await logAction({ orgId, who: actor.who, source: actor.source, what: 'create', level: 'campaign', objectId: created.campaignId, after: { status: 'PAUSED', ads: created.ads.length, dailyBudget: d.dailyBudget } });
  return { campaignId: campaignRowId, metaCampaignId: created.campaignId, adsetId: created.adsetId, leadFormId: created.leadFormId || null, ads: created.ads.map((a) => a.adId), status: 'PAUSED' };
}
