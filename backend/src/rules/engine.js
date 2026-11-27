/**
 * Rules engine — pure evaluation (no I/O). The runner (rules/runner.js) builds the
 * snapshot from Postgres, calls evaluate(), then stores alerts / applies auto-mode.
 * Default thresholds are the spec's; per-account overrides come from the rules table.
 */

export const DEFAULTS = {
  money_burn:       { enabled: true, cplMultiple: 3 },
  expensive_ad:     { enabled: true, overAvgPct: 50, days: 3 },
  winner:           { enabled: true, underTargetPct: 30, days: 3, budgetStepPct: 20 },
  creative_fatigue: { enabled: true, frequency: 3, ctrDropPct: 30 },
  delivery_stopped: { enabled: true, hours: 24 },
  ad_rejected:      { enabled: true },
  tracking_broken:  { enabled: true, hours: 24 },
  lead_followup:    { enabled: true, minutes: 15 },
  out_of_area:      { enabled: true, maxPct: 15, minLeads: 10 },
  wallet_low:       { enabled: true },
};

export const LEARNING = { minDays: 3, maxDays: 7, results: 50 };

/**
 * Creative fatigue score 0–100 for creatives.fatigue_score (higher = more tired).
 * Half from frequency (3+ = full), half from the CTR drop over the last 7 days (30%+ = full).
 */
export function fatigueScore(days = []) {
  const d7 = [...days].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-7);
  if (d7.length < 3) return 0;
  const freq = Math.max(...d7.map((r) => Number(r.frequency) || 0));
  const ctr = (rows) => { const imp = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0); return imp ? rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0) / imp : 0; };
  const first = ctr(d7.slice(0, 3)); const last = ctr(d7.slice(-3));
  const drop = first > 0 ? Math.max(0, (first - last) / first) : 0;
  return Math.round(Math.min(freq / 3, 1) * 50 + Math.min(drop / 0.3, 1) * 50);
}

export function isInLearning({ learningStage, daysSinceLaunch, results7d }) {
  if (learningStage === 'SUCCESS') return false;
  if (learningStage === 'LEARNING') return true;
  if (daysSinceLaunch == null) return false;
  if (daysSinceLaunch < LEARNING.minDays) return true;
  return daysSinceLaunch < LEARNING.maxDays && (results7d || 0) < LEARNING.results;
}

const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const cplOf = (rows) => { const l = sum(rows, 'leads'); return l > 0 ? sum(rows, 'spend') / l : null; };
const lastN = (days, n) => [...days].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-n);
const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * snapshot = {
 *   targetCpl, accountAvgCpl (30d), now,
 *   campaigns: [{ metaId, name, status, objective, destination, launchedAt, todayImpressions, yesterdayImpressions, pixelLastFiredAt }],
 *   adsets:    [{ metaId, campaignMetaId, name, status, dailyBudget, learningStage, daysSinceLaunch, days:[{date,spend,leads,impressions}] }],
 *   ads:       [{ metaId, adsetMetaId, name, status, effectiveStatus, reviewFeedback, lifetimeSpend, lifetimeLeads, days:[{date,spend,leads,impressions,clicks,frequency,ctr}] }],
 *   leadsAwaiting: [{ id, name, minutesWaiting }],
 *   outOfArea: { total, outOfArea } (last 7d),
 *   wallet: { balance, threshold, avgDailySpend } | null,
 * }
 */
export function evaluate(snapshot, overrides = {}) {
  const cfg = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { ...v, ...(overrides[k] || {}) }]));
  const out = [];
  const push = (f) => out.push({ severity: 'warning', ...f });
  const target = snapshot.targetCpl;
  const adsetsById = new Map(snapshot.adsets.map((s) => [s.metaId, s]));
  const learningOf = (s) => (s ? isInLearning({ learningStage: s.learningStage, daysSinceLaunch: s.daysSinceLaunch, results7d: sum(lastN(s.days, 7), 'leads') }) : false);

  for (const ad of snapshot.ads.filter((a) => a.status === 'ACTIVE')) {
    const set = adsetsById.get(ad.adsetMetaId);
    const learning = learningOf(set);

    // 1. Paisa jal raha: spend >= 3x target CPL and 0 leads (allowed even in learning — that is real waste)
    if (cfg.money_burn.enabled && target && ad.lifetimeLeads === 0 && ad.lifetimeSpend >= cfg.money_burn.cplMultiple * target) {
      push({
        ruleType: 'money_burn', level: 'ad', objectId: ad.metaId,
        message: `"${ad.name}" pe ${rupees(ad.lifetimeSpend)} lag gaye, ek bhi lead nahi. Band kar dein?`,
        suggestedAction: { type: 'pause', level: 'ad', metaId: ad.metaId },
      });
      continue;
    }
    if (learning) continue; // no big changes during learning phase

    // 2. Mehnga ad: CPL 50%+ over account average for 3 days
    const recent = lastN(ad.days, cfg.expensive_ad.days);
    const adCpl = cplOf(recent);
    if (cfg.expensive_ad.enabled && snapshot.accountAvgCpl && recent.length >= cfg.expensive_ad.days && adCpl != null
      && adCpl > snapshot.accountAvgCpl * (1 + cfg.expensive_ad.overAvgPct / 100)) {
      push({
        ruleType: 'expensive_ad', level: 'ad', objectId: ad.metaId,
        message: `"${ad.name}" ki lead ${rupees(adCpl)} ki pad rahi hai (account average ${rupees(snapshot.accountAvgCpl)}). Band kar dein?`,
        suggestedAction: { type: 'pause', level: 'ad', metaId: ad.metaId },
      });
    }

    // 4. Creative thak gaya: frequency > 3 and CTR down 30%+ over 7 days
    if (cfg.creative_fatigue.enabled) {
      const d7 = lastN(ad.days, 7);
      if (d7.length >= 6) {
        const first = d7.slice(0, 3); const last = d7.slice(-3);
        const ctr = (rows) => { const imp = sum(rows, 'impressions'); return imp ? sum(rows, 'clicks') / imp : 0; };
        const freq = Math.max(...d7.map((r) => Number(r.frequency) || 0));
        const c1 = ctr(first); const c2 = ctr(last);
        if (freq > cfg.creative_fatigue.frequency && c1 > 0 && (c1 - c2) / c1 >= cfg.creative_fatigue.ctrDropPct / 100) {
          push({
            ruleType: 'creative_fatigue', level: 'ad', objectId: ad.metaId,
            message: `"${ad.name}" log baar baar dekh chuke hain (frequency ${freq.toFixed(1)}), click ${Math.round(((c1 - c2) / c1) * 100)}% gire. 3 naye creatives banao — AI drafts ready hain.`,
            suggestedAction: { type: 'new_creatives', count: 3, adsetMetaId: ad.adsetMetaId },
          });
        }
      }
    }
  }

  // 3. Winner: ad set CPL 30%+ under target, stable for 3 days -> +20% budget
  if (cfg.winner.enabled && target) {
    for (const s of snapshot.adsets.filter((x) => x.status === 'ACTIVE')) {
      if (learningOf(s)) continue;
      const recent = lastN(s.days, cfg.winner.days);
      if (recent.length < cfg.winner.days) continue;
      const limit = target * (1 - cfg.winner.underTargetPct / 100);
      const stable = recent.every((d) => d.leads > 0 && d.spend / d.leads <= limit);
      if (stable && s.dailyBudget > 0) {
        const step = Math.min(cfg.winner.budgetStepPct, 20) / 100;
        const next = Math.floor(s.dailyBudget * (1 + step));
        push({
          ruleType: 'winner', level: 'adset', objectId: s.metaId, severity: 'info',
          message: `"${s.name}" achha chal raha hai — lead ${rupees(cplOf(recent))} ki (target ${rupees(target)}). Budget ${rupees(s.dailyBudget)} se ${rupees(next)}/din karein?`,
          suggestedAction: { type: 'budget', level: 'adset', metaId: s.metaId, from: s.dailyBudget, to: next },
        });
      }
    }
  }

  for (const c of snapshot.campaigns.filter((x) => x.status === 'ACTIVE')) {
    const hoursLive = c.launchedAt ? (snapshot.now - new Date(c.launchedAt)) / 3600_000 : 0;
    // 5. Delivery ruk gayi
    if (cfg.delivery_stopped.enabled && hoursLive >= cfg.delivery_stopped.hours && !c.todayImpressions && !c.yesterdayImpressions) {
      push({ ruleType: 'delivery_stopped', level: 'campaign', objectId: c.metaId, severity: 'critical', message: `"${c.name}" pe 24 ghante se koi impression nahi. Payment ya ad approval check karo.` });
    }
    // 7. Tracking toota
    if (cfg.tracking_broken.enabled && c.destination === 'WEBSITE') {
      const lastFired = c.pixelLastFiredAt ? new Date(c.pixelLastFiredAt) : null;
      if (!lastFired || (snapshot.now - lastFired) / 3600_000 >= cfg.tracking_broken.hours) {
        push({ ruleType: 'tracking_broken', level: 'campaign', objectId: c.metaId, severity: 'critical', message: `"${c.name}": website ka Pixel event 24 ghante se nahi aaya — tracking toot gayi hai.` });
      }
    }
  }

  // 6. Ad reject
  if (cfg.ad_rejected.enabled) {
    for (const ad of snapshot.ads.filter((a) => a.effectiveStatus === 'DISAPPROVED')) {
      const reason = ad.reviewFeedback ? Object.values(ad.reviewFeedback.global || ad.reviewFeedback).join('; ') : 'Meta ne kaaran nahi bataya';
      push({ ruleType: 'ad_rejected', level: 'ad', objectId: ad.metaId, severity: 'critical', message: `"${ad.name}" Meta ne reject kiya. Kaaran: ${reason}. AI ne policy-safe naya text bana diya hai.`, suggestedAction: { type: 'rewrite_copy', metaId: ad.metaId, reason } });
    }
  }

  // 8. Lead follow-up
  if (cfg.lead_followup.enabled) {
    for (const l of snapshot.leadsAwaiting || []) {
      if (l.minutesWaiting >= cfg.lead_followup.minutes) {
        push({ ruleType: 'lead_followup', level: 'lead', objectId: String(l.id), severity: 'critical', message: `Nayi lead ${l.name || ''} ko ${l.minutesWaiting} min se kisi ne call nahi kiya. Abhi call karo!` });
      }
    }
  }

  // Lead quality: out of area %
  const oa = snapshot.outOfArea;
  if (cfg.out_of_area.enabled && oa && oa.total >= cfg.out_of_area.minLeads) {
    const pct = (oa.outOfArea / oa.total) * 100;
    if (pct > cfg.out_of_area.maxPct) {
      push({ ruleType: 'out_of_area', level: 'account', objectId: snapshot.accountMetaId || 'account', message: `Pichle 7 din ki ${Math.round(pct)}% leads area ke bahar se hain. Radius/language/offer check karo.` });
    }
  }

  // Model B wallet
  const w = snapshot.wallet;
  if (cfg.wallet_low.enabled && w && w.balance <= w.threshold) {
    const daysLeft = w.avgDailySpend > 0 ? Math.floor(w.balance / w.avgDailySpend) : null;
    push({ ruleType: 'wallet_low', level: 'account', objectId: snapshot.accountMetaId || 'account', severity: w.balance <= 0 ? 'critical' : 'warning',
      message: w.balance <= 0 ? 'Wallet khaali — ads pause kar diye gaye hain. Top-up karein.' : `Wallet mein ${rupees(w.balance)} bache hain${daysLeft != null ? ` (~${daysLeft} din)` : ''}. Jaldi top-up karein.` });
  }

  return out.map((f) => ({ ...f, dedupeKey: `${f.ruleType}:${f.objectId}` }));
}
