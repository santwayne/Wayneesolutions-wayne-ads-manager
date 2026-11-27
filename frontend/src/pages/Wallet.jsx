import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, inr } from '../api.js';

export default function Wallet() {
  const { orgId } = useParams();
  const [d, setD] = useState(null); const [amt, setAmt] = useState(''); const [ref, setRef] = useState(''); const [err, setErr] = useState('');
  const load = () => api('GET', `/orgs/${orgId}/wallet`).then(setD);
  useEffect(() => { load(); }, [orgId]);
  const top = async (e) => { e.preventDefault(); setErr(''); try { await api('POST', `/orgs/${orgId}/wallet/topup`, { amount: Number(amt), ref }); setAmt(''); setRef(''); load(); } catch (x) { setErr(x.message); } };
  // Razorpay Checkout (Phase 2): client pays online, wallet credited after signature check.
  const payOnline = async (purpose, extra = {}) => {
    setErr('');
    try {
      const o = await api('POST', `/orgs/${orgId}/billing/orders`, { purpose, ...extra });
      if (!window.Razorpay) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js'; sc.onload = ok; sc.onerror = no; document.body.appendChild(sc); });
      new window.Razorpay({ key: o.keyId, order_id: o.orderId, amount: Math.round(o.amount * 100), currency: 'INR', name: o.name, prefill: o.prefill,
        handler: async (resp) => { try { await api('POST', `/orgs/${orgId}/billing/verify`, resp); load(); } catch (x) { setErr(x.message); } } }).open();
    } catch (x) { setErr(x.message); }
  };
  if (!d) return null;
  return (
    <>
      <h1>Wallet (Model B)</h1><p className="sub">Client pehle top-up karta hai. Khatam hone se pehle WhatsApp alert, 0 pe ads khud pause.</p>
      <div className="grid g3">
        <div className="card stat"><div className="k">Balance</div><div className="v">{inr(d.wallet?.balance)}</div></div>
        <div className="card stat"><div className="k">Low-balance alert</div><div className="v">{inr(d.wallet?.low_balance_threshold)}</div></div>
        <div className="card stat"><div className="k">Status</div><div className="v">{d.wallet?.auto_paused ? <span className="pill red">Ads paused</span> : <span className="pill green">Chal raha</span>}</div></div>
      </div>
      <form className="card row" onSubmit={top} style={{ marginTop: 14 }}>
        <input type="number" placeholder="Amount ₹" value={amt} onChange={(e) => setAmt(e.target.value)} required />
        <input placeholder="Payment ref (UPI/NEFT id) — staff only" value={ref} onChange={(e) => setRef(e.target.value)} />
        <button>Top-up record karo (staff)</button>
        <button type="button" className="primary" disabled={!amt} onClick={() => payOnline('wallet_topup', { amount: Number(amt) })}>Online pay karo</button>
      </form>
      {err && <div className="err">{err}</div>}
      <h2>Ledger</h2>
      <table><thead><tr><th>Kab</th><th>Type</th><th>Amount</th><th>Balance</th><th>Ref</th></tr></thead>
        <tbody>{d.ledger.map((l) => <tr key={l.id}><td>{new Date(l.created_at).toLocaleString('en-IN')}</td><td>{l.kind}</td><td style={{ color: l.amount < 0 ? '#c53030' : '#12805c' }}>{inr(l.amount)}</td><td>{inr(l.balance_after)}</td><td>{l.ref}</td></tr>)}</tbody></table>
      <h2>Invoices (GST)</h2>
      <table><thead><tr><th>No.</th><th>Mahina</th><th>Ad spend</th><th>Service fee</th><th>GST</th><th>Total</th></tr></thead>
        <tbody>{d.invoices.map((i) => <tr key={i.id}><td>{i.number}</td><td>{String(i.month).slice(0, 7)}</td><td>{inr(i.ad_spend)}</td><td>{inr(i.service_fee)}</td><td>{inr(i.gst)}</td><td><b>{inr(i.total)}</b> {i.status === 'paid' ? <span className="pill green">paid</span> : <button onClick={() => payOnline('invoice', { invoiceId: i.id })}>Pay</button>}</td></tr>)}</tbody></table>
    </>
  );
}
