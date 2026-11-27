import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

const RULE_LABEL = { money_burn: 'Paisa jal raha', expensive_ad: 'Mehnga ad', winner: 'Winner (budget +20%)', creative_fatigue: 'Creative thak gaya', delivery_stopped: 'Delivery ruk gayi', ad_rejected: 'Ad reject', tracking_broken: 'Tracking toota', lead_followup: 'Lead follow-up', out_of_area: 'Out of area %', wallet_low: 'Wallet low' };

export default function Settings() {
  const { orgId } = useParams();
  const [org, setOrg] = useState(null); const [accs, setAccs] = useState([]); const [rules, setRules] = useState([]); const [tpls, setTpls] = useState([]);
  const [acc, setAcc] = useState(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = () => Promise.all([
    api('GET', `/orgs/${orgId}`).then(setOrg), api('GET', `/orgs/${orgId}/ad-accounts`).then(setAccs),
    api('GET', `/orgs/${orgId}/rules`).then(setRules), api('GET', '/wizard/templates').then((r) => setTpls(r.templates)),
  ]);
  useEffect(() => { load(); }, [orgId]);
  const run = (fn) => async (...a) => { setErr(''); setMsg(''); try { await fn(...a); setMsg('Save ho gaya'); load(); } catch (x) { setErr(x.message); } };
  const save = run((p) => api('PATCH', `/orgs/${orgId}/settings`, p));
  const addAcc = run(async (e) => {
    e.preventDefault();
    await api('POST', `/orgs/${orgId}/ad-accounts`, { metaAccountId: acc.id, sectorTemplate: acc.sector, pageId: acc.page, whatsappPhone: acc.wa || undefined, pixelId: acc.pixel || undefined, targetCpl: acc.cpl ? Number(acc.cpl) : undefined, serviceAreaPincodes: (acc.pins || '').split(/[ ,]+/).filter(Boolean) });
    setAcc(null);
  });
  const saveRule = run((r, enabled, threshold) => api('PUT', `/orgs/${orgId}/rules/${r.ruleType}`, { enabled, threshold }));
  if (!org) return null;
  const owner = org.role === 'owner';
  return (
    <>
      <h1>Settings</h1>
      {msg && <p className="muted">{msg}</p>}{err && <p className="err">{err}</p>}
      <div className="grid g2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Autopilot aur paisa ki safety</h2>
          <label><input type="checkbox" style={{ width: 'auto' }} disabled={!owner} checked={org.auto_mode} onChange={(e) => save({ autoMode: e.target.checked })} /> Auto-mode: sirf "pause" aur "budget +20% tak" bina poochhe (har action WhatsApp pe batayenge)</label>
          <label>Roz ki auto-action limit</label><input type="number" disabled={!owner} defaultValue={org.auto_daily_action_limit} onBlur={(e) => save({ autoDailyActionLimit: Number(e.target.value) })} />
          <label>Account ki daily budget cap (₹) — isse upar kuch nahi</label><input type="number" disabled={!owner} defaultValue={org.daily_budget_cap || ''} onBlur={(e) => save({ dailyBudgetCap: e.target.value ? Number(e.target.value) : null })} />
          <label><input type="checkbox" style={{ width: 'auto' }} disabled={!owner} checked={org.ai_call_enabled} onChange={(e) => save({ aiCallEnabled: e.target.checked })} /> Nayi lead pe WayneRing AI call (2 min mein)</label>
          <label>Owner ka WhatsApp</label><input disabled={!owner} defaultValue={org.whatsapp_number || ''} onBlur={(e) => save({ whatsappNumber: e.target.value })} />
          <label>Privacy policy URL</label><input disabled={!owner} defaultValue={org.privacy_policy_url || ''} onBlur={(e) => save({ privacyPolicyUrl: e.target.value })} />
          {!owner && <p className="muted">Ye settings sirf Owner badal sakta hai.</p>}
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Ad accounts</h2>
          {accs.map((a) => <div key={a.id} className="check"><span className="dot ok" /><div>{a.meta_account_id} · {a.sector_template} · Page {a.page_id}<div className="muted">Target CPL ₹{a.target_cpl || '—'} · pincodes {a.service_area_pincodes.join(', ') || '—'} · last sync {a.last_synced_at ? new Date(a.last_synced_at).toLocaleString('en-IN') : 'abhi nahi'}</div></div></div>)}
          {!acc ? <button onClick={() => setAcc({ sector: 'other' })}>+ Ad account jodo</button> : (
            <form onSubmit={addAcc}>
              <label>Meta ad account (act_…)</label><input required value={acc.id || ''} onChange={(e) => setAcc({ ...acc, id: e.target.value })} />
              <label>Business type</label><select value={acc.sector} onChange={(e) => setAcc({ ...acc, sector: e.target.value })}>{tpls.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
              <label>Facebook Page ID</label><input required value={acc.page || ''} onChange={(e) => setAcc({ ...acc, page: e.target.value })} />
              <label>WhatsApp Business number (WhatsApp ads ke liye)</label><input value={acc.wa || ''} onChange={(e) => setAcc({ ...acc, wa: e.target.value })} />
              <label>Pixel ID (website clients)</label><input value={acc.pixel || ''} onChange={(e) => setAcc({ ...acc, pixel: e.target.value })} />
              <label>Target cost per lead (₹)</label><input type="number" value={acc.cpl || ''} onChange={(e) => setAcc({ ...acc, cpl: e.target.value })} />
              <label>Service area pincodes (comma)</label><input value={acc.pins || ''} onChange={(e) => setAcc({ ...acc, pins: e.target.value })} />
              <div className="row" style={{ marginTop: 10 }}><button className="primary">Save</button><button type="button" onClick={() => setAcc(null)}>Cancel</button></div>
            </form>
          )}
        </div>
      </div>
      <h2>Rules (thresholds)</h2>
      <table><thead><tr><th>Rule</th><th>On</th><th>Thresholds</th><th>Last fired</th></tr></thead>
        <tbody>{rules.map((r) => (
          <tr key={r.ruleType}><td>{RULE_LABEL[r.ruleType]}</td>
            <td><input type="checkbox" style={{ width: 'auto' }} disabled={!owner} checked={r.enabled} onChange={(e) => saveRule(r, e.target.checked, Object.fromEntries(Object.entries(r.threshold).filter(([k]) => k !== 'enabled')))} /></td>
            <td className="row" style={{ flexWrap: 'wrap' }}>{Object.entries(r.threshold).filter(([k]) => k !== 'enabled').map(([k, v]) => (
              <span key={k} className="row" style={{ gap: 4 }}><span className="muted">{k}</span><input type="number" style={{ width: 80 }} disabled={!owner} defaultValue={v}
                onBlur={(e) => saveRule(r, r.enabled, { ...Object.fromEntries(Object.entries(r.threshold).filter(([x]) => x !== 'enabled')), [k]: Number(e.target.value) })} /></span>))}</td>
            <td className="muted">{r.lastFired ? new Date(r.lastFired).toLocaleString('en-IN') : '—'}</td></tr>))}</tbody></table>
    </>
  );
}
