/**
 * Fully populated test account for the MCP directory review / sales demos.
 *   REVIEW_EMAIL=review@wayneesolutions.com REVIEW_PASSWORD=... node scripts/seed-review-account.js
 * Uses a demo ad account (act_demo...), so no tool ever calls Meta: writes pass the
 * same safety checks and return success. Re-running resets the demo data.
 */
import bcrypt from 'bcryptjs';
import { pool, query } from '../src/lib/db.js';
import { migrate } from '../src/db/migrate.js';

const email = process.env.REVIEW_EMAIL; const password = process.env.REVIEW_PASSWORD;
if (!email || !password || password.length < 12) { console.error('Set REVIEW_EMAIL and REVIEW_PASSWORD (12+ chars)'); process.exit(1); }
await migrate();

await query("DELETE FROM orgs WHERE name LIKE 'Demo % (review)'");
const { rows: [u] } = await query(
  `INSERT INTO users (email, name, password_hash) VALUES (lower($1),'Review Account',$2)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`, [email, await bcrypt.hash(password, 10)]);

async function business(name, sector, act, model) {
  const { rows: [o] } = await query("INSERT INTO orgs (name, type, payment_model, privacy_policy_url, daily_budget_cap) VALUES ($1,'business',$2,'https://example.com/privacy',5000) RETURNING id", [name, model]);
  await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')", [u.id, o.id]);
  if (model === 'B') await query('INSERT INTO wallets (org_id, balance) VALUES ($1, 18500)', [o.id]);
  const { rows: [a] } = await query(
    "INSERT INTO ad_accounts (org_id, meta_account_id, name, sector_template, page_id, target_cpl, service_area_pincodes, backfilled_at) VALUES ($1,$2,$3,$4,$5,200,'{141001,141002}',now()) RETURNING *",
    [o.id, act, name, sector, `${act}_page`]);
  return { orgId: o.id, acc: a };
}

const day = (d) => `CURRENT_DATE - ${d}`;
async function campaign(b, cid, name, budget, ads) {
  const { rows: [c] } = await query("INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status, objective, created_by_wizard, launched_at) VALUES ($1,$2,$3,$4,'ACTIVE','OUTCOME_LEADS',true, now() - interval '20 days') RETURNING id", [b.orgId, b.acc.id, cid, name]);
  const { rows: [s] } = await query("INSERT INTO adsets (org_id, campaign_id, meta_id, name, status, daily_budget, learning_stage, optimization_goal, destination_type) VALUES ($1,$2,$3,$4,'ACTIVE',$5,'SUCCESS','LEAD_GENERATION','ON_AD') RETURNING id", [b.orgId, c.id, `${cid}_set`, `${name} — ad set`, budget]);
  for (const [i, ad] of ads.entries()) await query("INSERT INTO ads (org_id, adset_id, meta_id, name, status, effective_status) VALUES ($1,$2,$3,$4,'ACTIVE',$5)", [b.orgId, s.id, `${cid}_ad${i}`, ad.name, ad.rejected ? 'DISAPPROVED' : 'ACTIVE']);
  for (let d = 0; d < 30; d++) {
    const spend = budget * (0.9 + (d % 5) * 0.04);
    let leadsTotal = 0;
    for (const [i, ad] of ads.entries()) {
      const share = spend / ads.length; const leads = ad.dud ? 0 : Math.max(0, Math.round(share / ad.cpl));
      leadsTotal += leads;
      await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, impressions, clicks, leads, frequency) VALUES ($1,'ad',$2,${day(d)},$3,$4,$5,$6,$7)`, [b.orgId, `${cid}_ad${i}`, share, Math.round(share * 15), Math.round(share * 0.25), leads, ad.freq || 1.7]);
    }
    for (const [lvl, id] of [['campaign', cid], ['adset', `${cid}_set`]]) await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, impressions, clicks, leads, frequency) VALUES ($1,$2,$3,${day(d)},$4,$5,$6,$7,1.8)`, [b.orgId, lvl, id, spend, Math.round(spend * 15), Math.round(spend * 0.25), leadsTotal]);
    await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, impressions, clicks, leads) VALUES ($1,'account',$2,${day(d)},$3,$4,$5,$6)
      ON CONFLICT (level, object_id, date) DO UPDATE SET spend = insights_daily.spend + EXCLUDED.spend, leads = insights_daily.leads + EXCLUDED.leads, impressions = insights_daily.impressions + EXCLUDED.impressions, clicks = insights_daily.clicks + EXCLUDED.clicks`,
    [b.orgId, b.acc.meta_account_id, spend, Math.round(spend * 15), Math.round(spend * 0.25), leadsTotal]);
  }
}

const ielts = await business('Demo IELTS Academy (review)', 'ielts', 'act_demo1001', 'B');
await campaign(ielts, 'demo_c1', 'Free demo class — Model Town', 800, [{ name: 'Free demo class — video', cpl: 150 }, { name: 'Band score test — photo', cpl: 190 }, { name: 'Canada study visa — carousel', dud: true }]);
await campaign(ielts, 'demo_c2', 'Weekend batch — Sarabha Nagar', 500, [{ name: 'Weekend batch — reel', cpl: 260, freq: 3.6 }, { name: 'Weekend batch — photo', cpl: 240 }]);
await query("INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status, objective, created_by_wizard) VALUES ($1,$2,'demo_c3','PTE crash course (paused, not launched)','PAUSED','OUTCOME_LEADS',true)", [ielts.orgId, ielts.acc.id]);
const rest = await business('Demo Bubble Tea Cafe (review)', 'restaurant', 'act_demo1002', 'A');
await campaign(rest, 'demo_c4', 'Flat 20% off — first order', 400, [{ name: 'Brown sugar boba — reel', cpl: 55 }, { name: 'Combo offer — photo', cpl: 70 }]);

const alerts = [
  [ielts.orgId, 'money_burn', 'ad', 'demo_c1_ad2', 'warning', '"Canada study visa — carousel" pe ₹8,000 lag gaye, ek bhi lead nahi. Band kar dein?', { type: 'pause', level: 'ad', metaId: 'demo_c1_ad2' }],
  [ielts.orgId, 'winner', 'adset', 'demo_c1_set', 'info', '"Free demo class" achha chal raha hai — lead ₹165 ki (target ₹200). Budget ₹800 se ₹960/din karein?', { type: 'budget', level: 'adset', metaId: 'demo_c1_set', from: 800, to: 960 }],
  [ielts.orgId, 'creative_fatigue', 'ad', 'demo_c2_ad0', 'warning', '"Weekend batch — reel" log baar baar dekh chuke hain (frequency 3.6). 3 naye creatives banao.', { type: 'new_creatives', count: 3 }],
];
for (const [o, t, l, id, sev, msg, act] of alerts) await query("INSERT INTO alerts (org_id, rule_type, level, object_id, severity, message, suggested_action, status, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8)", [o, t, l, id, sev, msg, JSON.stringify(act), `${t}:${id}`]);
const names = ['Ravi Kumar', 'Simran Kaur', 'Amit Sharma', 'Harpreet Singh', 'Neha Verma', 'Gurpreet Gill', 'Rohit Arora', 'Pooja Mehta'];
for (const [i, n] of names.entries()) {
  const st = ['won', 'consultation_booked', 'new', 'contacted', 'qualified', 'won', 'lost', 'new'][i];
  await query("INSERT INTO leads (org_id, meta_lead_id, name, phone, city, pincode, status, out_of_area, crm_lead_id, page_id, campaign_id, created_at) VALUES ($1,$2,$3,$4,'Ludhiana',$5,$6,$7,$8,$9,'demo_c1', now() - make_interval(days => $10))",
    [ielts.orgId, `demo_lead_${i}`, n, `9198000000${String(i).padStart(2, '0')}`, i === 2 ? '800001' : '141002', st, i === 2, `demo-crm-${i}`, ielts.acc.page_id, i]);
}
await query("INSERT INTO recommendations (org_id, ad_account_id, week_start, payload) VALUES ($1,$2,date_trunc('week', CURRENT_DATE)::date,$3)", [ielts.orgId, ielts.acc.id, JSON.stringify({
  summary: 'Pichle hafte ₹8,700 lage, 48 leads, ek lead ₹181 ki.',
  actions: [{ type: 'pause', title: '"Canada study visa — carousel" band karo', why: '₹8,000 kharch, 0 leads', level: 'ad', objectId: 'demo_c1_ad2' },
    { type: 'scale', title: '"Free demo class" ka budget 20% badhao', why: 'Lead ₹165 ki, target ₹200 se sasti', level: 'adset', objectId: 'demo_c1_set' },
    { type: 'test', title: 'Weekend batch ke 3 naye reels test karo', why: 'Frequency 3.6, click 32% gire', level: null, objectId: null }],
  copies: ['Free IELTS demo class is Saturday! Band score test bhi free. Seat book karein 👇'],
})]);
console.log(`Review account ready: ${email} — businesses ${ielts.orgId} (IELTS, wallet) and ${rest.orgId} (cafe)`);
await pool.end();
