import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, inr } from '../api.js';
import MapPicker from './MapPicker.jsx';

const STEPS = ['Kya chahiye', 'Business type', 'Kahan aur kisko', 'Budget', 'Offer aur ad', 'Lead form', 'Review'];
const GOAL_HELP = { lead_form: 'Log form mein naam aur number bharenge', whatsapp: 'Log seedha aapko WhatsApp karenge', call: 'Log ad se seedha call karenge', website: 'Log website pe book/kharid karenge', store_visit: 'Aas paas ke log dukaan pe aayenge' };

function Checklist({ checks, onFix }) {
  if (!checks) return null;
  if (!checks.length) return <div className="check"><span className="dot ok" />Sab hara — ready hai.</div>;
  return checks.map((c, i) => (
    <div className="check" key={i}>
      <span className={`dot ${c.level}`} />
      <div style={{ flex: 1 }}>{c.message}{c.fix && <div className="muted">{c.fix}</div>}</div>
      {c.fixPatch && <button onClick={() => onFix(c.fixPatch)}>Theek karo</button>}
    </div>
  ));
}

export default function Wizard() {
  const { orgId } = useParams();
  const nav = useNavigate();
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [draft, setDraft] = useState(null);
  const [step, setStep] = useState(0);
  const [v, setV] = useState(null);
  const [copy, setCopy] = useState(null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);

  useEffect(() => {
    api('GET', '/wizard/templates').then(setMeta);
    api('GET', `/orgs/${orgId}/ad-accounts`).then(setAccounts);
    // Continue a draft started elsewhere (e.g. from Claude via the MCP connector).
    const existing = new URLSearchParams(window.location.search).get('draft');
    if (existing) api('GET', `/orgs/${orgId}/drafts/${existing}`).then((dr) => { setDraft(dr); }).catch(() => {});
  }, [orgId]);

  const d0 = draft?.data || {};
  // Smart defaults: show the template defaults as already chosen (user can still change).
  const d = { ...d0, goal: d0.goal || v?.draft?.goal, sector: d0.sector || v?.draft?.sector };
  const tpl = useMemo(() => meta?.templates.find((t) => t.key === d.sector), [meta, d.sector]);
  const steps = d.goal === 'lead_form' ? STEPS : STEPS.filter((s) => s !== 'Lead form');
  const name = steps[step];

  const start = async (adAccountId) => setDraft(await api('POST', `/orgs/${orgId}/drafts`, { adAccountId, data: {} }));
  const patch = async (p) => {
    const nd = await api('PATCH', `/orgs/${orgId}/drafts/${draft.id}`, p);
    setDraft(nd);
    setV(await api('GET', `/orgs/${orgId}/drafts/${draft.id}/validate?reach=${name === 'Kahan aur kisko' ? 1 : 0}`));
  };
  useEffect(() => { if (draft) api('GET', `/orgs/${orgId}/drafts/${draft.id}/validate?reach=0`).then(setV); }, [draft?.id]);

  const genCopy = async () => {
    setBusy('copy'); setErr('');
    try { setCopy(await api('POST', `/orgs/${orgId}/drafts/${draft.id}/copy`)); } catch (x) { setErr(x.message); } finally { setBusy(''); }
  };
  const toggleText = (key, t, max) => {
    const cur = d[key] || [];
    patch({ [key]: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].slice(-max) });
  };
  const upload = async (files) => {
    setBusy('media'); setErr('');
    try {
      for (const f of files) {
        const r = await api('POST', `/orgs/${orgId}/drafts/${draft.id}/media`, f, { raw: true, contentType: f.type });
        setDraft((x) => ({ ...x, data: { ...x.data, media: r.media } }));
      }
      setV(await api('GET', `/orgs/${orgId}/drafts/${draft.id}/validate?reach=0`));
    } catch (x) { setErr(x.message); } finally { setBusy(''); }
  };
  const create = async () => {
    setBusy('create'); setErr('');
    try { setCreated(await api('POST', `/orgs/${orgId}/drafts/${draft.id}/create`)); } catch (x) { setErr(x.details?.map?.((c) => c.message).join(' · ') || x.message); } finally { setBusy(''); }
  };
  const launch = async () => {
    setBusy('launch'); setErr('');
    try { await api('POST', `/orgs/${orgId}/campaigns/${created.metaCampaignId}/launch`); nav(`/orgs/${orgId}`); } catch (x) { setErr(x.message); } finally { setBusy(''); }
  };

  if (!meta) return <p className="muted">Load ho raha hai…</p>;
  if (!draft) {
    return (
      <>
        <h1>Naya campaign</h1><p className="sub">7 sawaal, 10 minute. Sab kuch pehle paused banega — aap "Launch" dabaoge tabhi chalega.</p>
        {!accounts.length && <p className="err">Pehle Settings mein ad account jodo.</p>}
        <div className="choices">{accounts.map((a) => <button key={a.id} className="choice" onClick={() => start(a.id)}><b>{a.name || a.meta_account_id}</b><div className="muted">{a.sector_template}</div></button>)}</div>
      </>
    );
  }

  const stepChecks = (codes) => v?.checks.filter((c) => codes.includes(c.code));
  const sel = (key) => d[key] || [];

  return (
    <>
      <div className="steps">{steps.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} title={s} />)}</div>
      <h1>{step + 1}. {name}</h1>

      {name === 'Kya chahiye' && (
        <>
          <p className="sub">Aapko kya chahiye?</p>
          <div className="choices">{meta.goals.map((g) => (
            <button key={g.key} className={`choice ${d.goal === g.key ? 'on' : ''}`} onClick={() => patch({ goal: g.key })}>
              <b>{g.label}</b><div className="muted">{GOAL_HELP[g.key]}</div></button>))}
          </div>
          {d.goal === 'website' && <><label>Website link (https://)</label><input defaultValue={d.websiteUrl || ''} onBlur={(e) => patch({ websiteUrl: e.target.value })} /></>}
          {d.goal === 'call' && <><label>Phone number (+91…)</label><input defaultValue={d.phone || ''} onBlur={(e) => patch({ phone: e.target.value })} /></>}
        </>
      )}

      {name === 'Business type' && (
        <div className="choices">{meta.templates.map((t) => (
          <button key={t.key} className={`choice ${d.sector === t.key ? 'on' : ''}`} onClick={() => patch({ sector: t.key, radiusKm: t.radiusKm, ageMin: t.ageMin, ageMax: t.ageMax, dailyBudget: t.recommendedDailyBudget })}>
            <b>{t.label}</b><div className="muted">Suggested {inr(t.recommendedDailyBudget)}/din · {t.radiusKm} km</div>
            {t.specialAdCategories.length > 0 && <div className="pill yellow" style={{ marginTop: 6 }}>Special category</div>}
          </button>))}
        </div>
      )}

      {name === 'Kahan aur kisko' && (
        <>
          <p className="sub">Map pe apne business ki jagah click karo.</p>
          <MapPicker value={d.location} radiusKm={d.radiusKm || tpl?.radiusKm || 10} onPick={(loc) => patch({ location: { ...loc, label: d.location?.label } })} />
          <div className="grid g2">
            <div><label>Radius: {d.radiusKm || tpl?.radiusKm} km</label><input type="range" min="1" max="80" value={d.radiusKm || tpl?.radiusKm || 10} onChange={(e) => setDraft({ ...draft, data: { ...d, radiusKm: Number(e.target.value) } })} onMouseUp={(e) => patch({ radiusKm: Number(e.target.value) })} onTouchEnd={(e) => patch({ radiusKm: Number(e.target.value) })} /></div>
            <div><label>Age: {d.ageMin || tpl?.ageMin}–{d.ageMax || tpl?.ageMax}</label>
              <div className="row"><input type="number" min="18" max="65" defaultValue={d.ageMin || tpl?.ageMin} onBlur={(e) => patch({ ageMin: Number(e.target.value) })} /><input type="number" min="18" max="65" defaultValue={d.ageMax || tpl?.ageMax} onBlur={(e) => patch({ ageMax: Number(e.target.value) })} /></div></div>
          </div>
          <p className="muted">Audience broad rahegi (Meta khud sahi log dhoondhega). {v?.estimate?.reach?.upper ? `Andaazan ${v.estimate.reach.lower?.toLocaleString('en-IN')}–${v.estimate.reach.upper.toLocaleString('en-IN')} log.` : ''}</p>
          <Checklist checks={stepChecks(['no_location', 'radius_range', 'age_range', 'audience_small', 'special_category'])} onFix={patch} />
        </>
      )}

      {name === 'Budget' && (
        <>
          <div className="card">
            <div className="stat"><div className="v">{inr(d.dailyBudget || tpl?.recommendedDailyBudget)}/din</div><div className="k">= mahine ka lagbhag {inr((d.dailyBudget || tpl?.recommendedDailyBudget) * 30.4)}</div></div>
            <input type="range" min="100" max="10000" step="50" value={d.dailyBudget || tpl?.recommendedDailyBudget || 500}
              onChange={(e) => setDraft({ ...draft, data: { ...d, dailyBudget: Number(e.target.value) } })} onMouseUp={(e) => patch({ dailyBudget: Number(e.target.value) })} onTouchEnd={(e) => patch({ dailyBudget: Number(e.target.value) })} />
            <p className="muted">Recommended minimum: <b>{inr(tpl?.minDailyBudget)}/din</b> · suggested {inr(tpl?.recommendedDailyBudget)}/din</p>
          </div>
          <Checklist checks={stepChecks(['budget_low', 'budget_over_cap'])} onFix={patch} />
        </>
      )}

      {name === 'Offer aur ad' && (
        <>
          <label>Offer 1 line mein</label>
          <input defaultValue={d.offer || ''} placeholder={tpl?.offerIdeas?.[0]} onBlur={(e) => patch({ offer: e.target.value })} />
          <div className="muted" style={{ marginTop: 6 }}>Ideas: {tpl?.offerIdeas?.map((o) => <a key={o} href="#" onClick={(e) => { e.preventDefault(); patch({ offer: o }); }} style={{ marginRight: 10 }}>{o}</a>)}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <label style={{ margin: 0 }}>Bhasha</label>
            <select value={d.language || 'hinglish'} onChange={(e) => patch({ language: e.target.value })} style={{ width: 160 }}>
              <option value="hinglish">Hinglish</option><option value="english">English</option><option value="punjabi">Punjabi</option>
            </select>
            <button className="primary" disabled={busy === 'copy' || !d.offer} onClick={genCopy}>{busy === 'copy' ? 'AI likh raha hai…' : '✨ AI se ad text banao'}</button>
          </div>
          {copy && (
            <div className="grid g2" style={{ marginTop: 14 }}>
              <div><h2>Text (3 chuno)</h2>{copy.primaryTexts.map((t) => <button key={t} className={`choice ${sel('primaryTexts').includes(t) ? 'on' : ''}`} style={{ width: '100%', marginBottom: 8, whiteSpace: 'pre-wrap' }} onClick={() => toggleText('primaryTexts', t, 3)}>{t}</button>)}</div>
              <div><h2>Headline</h2>{copy.headlines.map((t) => <button key={t} className={`choice ${sel('headlines').includes(t) ? 'on' : ''}`} style={{ width: '100%', marginBottom: 8 }} onClick={() => toggleText('headlines', t, 3)}>{t}</button>)}</div>
            </div>
          )}
          <h2>Photo / video (3–5)</h2>
          <input type="file" accept="image/*" multiple onChange={(e) => upload([...e.target.files])} disabled={busy === 'media'} />
          {busy === 'media' && <p className="muted">Upload + quality check ho raha hai…</p>}
          <div className="thumbs" style={{ marginTop: 10 }}>{(d.media || []).map((m, i) => <img key={i} src={m.url || m.thumbnailUrl} alt={`creative ${i + 1}`} />)}</div>
          <Checklist checks={stepChecks(['no_offer', 'weak_offer', 'no_text', 'no_headline', 'blocked_phrase', 'personal_attribute', 'before_after', 'superlative', 'no_media', 'few_media', 'aspect', 'blurry', 'text_heavy', 'low_res', 'video_long'])} onFix={patch} />
        </>
      )}

      {name === 'Lead form' && (
        <>
          <p className="sub">Form "higher intent" rahega (bharne se pehle log confirm karenge) — junk leads kam.</p>
          <div className="card">
            <ol>
              <li>Poora naam</li><li>Phone number</li><li>City</li><li>Pincode <span className="muted">(bahar wale area ki lead "out of area" tag hogi, AI call nahi)</span></li>
              {(d.formQuestions || []).map((q) => <li key={q.key}>{q.label}</li>)}
              <li><b>{(d.qualifyingQuestion || {}).label || 'Aap kab tak shuru karna chahte hain?'}</b> <span className="muted">(qualifying)</span></li>
            </ol>
            <p className="muted">Thank-you screen pe Call / WhatsApp button.</p>
          </div>
          <label>Client ki privacy policy link (Meta ke liye zaroori)</label>
          <input defaultValue={d.privacyPolicyUrl || ''} placeholder="https://…/privacy" onBlur={(e) => patch({ privacyPolicyUrl: e.target.value })} />
          <Checklist checks={stepChecks(['no_privacy_policy'])} onFix={patch} />
        </>
      )}

      {name === 'Review' && (
        <div className="grid g2">
          <div className="preview">
            {d.media?.[0]?.url && <img src={d.media[0].url} alt="preview" />}
            <div className="txt">{d.primaryTexts?.[0] || 'Ad text chuno'}</div>
            <div className="bar"><b>{d.headlines?.[0]}</b><span className="btn">{d.goal === 'whatsapp' ? 'WhatsApp' : d.goal === 'call' ? 'Call now' : 'Sign up'}</span></div>
          </div>
          <div>
            <div className="card">
              <div>🎯 {meta.goals.find((g) => g.key === v?.draft.goal)?.label}</div>
              <div>🏷️ {tpl?.label}</div>
              <div>📍 {v?.draft.radiusKm} km · age {v?.draft.ageMin}–{v?.draft.ageMax}</div>
              <div>💰 {inr(v?.estimate.dailyBudget)}/din (~{inr(v?.estimate.monthlyBudget)}/mahina)</div>
              <div>🖼️ {Math.min(5, d.media?.length || 0)} ads (creative test)</div>
            </div>
            <h2>Checklist</h2>
            <Checklist checks={v?.checks} onFix={patch} />
            {err && <div className="err">{err}</div>}
            {!created ? (
              <button className="primary" style={{ marginTop: 14 }} disabled={v?.blocking || busy === 'create'} onClick={create}>{busy === 'create' ? 'Ban raha hai…' : 'Create (paused)'}</button>
            ) : (
              <div className="card" style={{ marginTop: 14 }}>
                ✅ Campaign Meta pe <b>PAUSED</b> ban gaya ({created.ads.length} ads).
                <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={busy === 'launch'} onClick={launch}>🚀 Launch</button><button onClick={() => nav(`/orgs/${orgId}`)}>Baad mein</button></div>
              </div>
            )}
          </div>
        </div>
      )}

      {err && name !== 'Review' && <div className="err">{err}</div>}
      <div className="row spread" style={{ marginTop: 24 }}>
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>← Peeche</button>
        {step < steps.length - 1 && <button className="primary" onClick={() => setStep(step + 1)}>Aage →</button>}
      </div>
    </>
  );
}
