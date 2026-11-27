import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import { requireOrg } from '../lib/auth.js';
import { ah, parse, actorOf } from '../routes/util.js';
import { topUp } from '../wallet/service.js';
import { logAction } from '../actions/service.js';
import { logger } from '../lib/logger.js';

/**
 * Razorpay: client pays wallet top-ups (Model B) and monthly invoices online.
 * Flow: POST /orders -> Checkout.js in the app -> POST /verify (signature) and/or the
 * payment.captured / order.paid webhook. Crediting is idempotent on the payment id,
 * so verify + webhook arriving together never double-credit.
 */
let rpFetch = (url, init) => fetch(url, init);
export function setRazorpayFetch(fn) { rpFetch = fn; }

async function createOrder({ amountPaise, receipt, notes }) {
  if (!config.razorpay.keyId) throw new AppError(503, 'billing_not_configured', 'Razorpay keys set nahi hain');
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const r = await rpFetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
  });
  const j = await r.json();
  if (!r.ok) throw new AppError(502, 'razorpay_error', j.error?.description || 'Razorpay order failed');
  return j;
}

export async function markPaid({ orderId, paymentId, source }) {
  const { rows: [p] } = await query('SELECT * FROM payments WHERE rp_order_id = $1', [orderId]);
  if (!p) throw notFound('Order nahi mila');
  if (p.status === 'paid') return { already: true, payment: p };
  const { rows: [upd] } = await query(
    "UPDATE payments SET status = 'paid', rp_payment_id = $2, paid_at = now() WHERE id = $1 AND status <> 'paid' RETURNING *", [p.id, paymentId]);
  if (!upd) return { already: true, payment: p };
  if (p.purpose === 'wallet_topup') {
    await topUp(p.org_id, Number(p.amount), { ref: `rzp:${paymentId}`, actor: { who: `razorpay:${source}`, source: 'system' } });
  } else if (p.purpose === 'invoice') {
    await query("UPDATE invoices SET status = 'paid' WHERE id = $1", [p.invoice_id]);
  } else if (p.purpose === 'subscription') {
    await query("UPDATE orgs SET subscription_status = 'active' WHERE id = $1", [p.org_id]);
  }
  await logAction({ orgId: p.org_id, who: `razorpay:${source}`, source: 'system', what: 'payment', after: { purpose: p.purpose, amount: Number(p.amount), paymentId } });
  return { payment: upd };
}

export const billing = Router();

billing.post('/orgs/:orgId/billing/orders', requireOrg('manager'), ah(async (req, res) => {
  const b = parse(z.object({ purpose: z.enum(['wallet_topup', 'invoice', 'subscription']), amount: z.number().positive().optional(), invoiceId: z.number().int().optional() }), req.body);
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE id = $1', [req.org.id]);
  let amount = b.amount;
  if (b.purpose === 'wallet_topup') {
    if (org.payment_model !== 'B') throw badRequest('Wallet sirf Model B clients ke liye hai');
    if (!amount || amount < 500) throw badRequest('Kam se kam ₹500 top-up');
  }
  if (b.purpose === 'invoice') {
    const { rows: [inv] } = await query("SELECT * FROM invoices WHERE id = $1 AND org_id = $2 AND status <> 'paid'", [b.invoiceId, req.org.id]);
    if (!inv) throw notFound('Invoice nahi mila ya paid hai');
    amount = Number(inv.total);
  }
  if (b.purpose === 'subscription') amount = Number(org.service_fee_monthly) * (1 + config.gstRate);
  if (!(amount > 0)) throw badRequest('Amount 0 hai');
  const order = await createOrder({ amountPaise: Math.round(amount * 100), receipt: `org${req.org.id}-${Date.now()}`, notes: { org_id: String(req.org.id), purpose: b.purpose } });
  await query('INSERT INTO payments (org_id, purpose, invoice_id, rp_order_id, amount) VALUES ($1,$2,$3,$4,$5)', [req.org.id, b.purpose, b.invoiceId || null, order.id, amount]);
  res.status(201).json({ orderId: order.id, amount, keyId: config.razorpay.keyId, name: 'Wayne E Solutions', prefill: { contact: org.whatsapp_number } });
}));

// Checkout success handler -> signature = HMAC(order_id|payment_id, key_secret)
billing.post('/orgs/:orgId/billing/verify', requireOrg('viewer'), ah(async (req, res) => {
  const b = parse(z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const expected = hmacSha256Hex(config.razorpay.keySecret, `${b.razorpay_order_id}|${b.razorpay_payment_id}`);
  if (!safeEqual(expected, b.razorpay_signature)) throw new AppError(400, 'bad_signature', 'Payment verify nahi hua');
  const { rows: [p] } = await query('SELECT org_id FROM payments WHERE rp_order_id = $1', [b.razorpay_order_id]);
  if (!p || p.org_id !== req.org.id) throw notFound('Order nahi mila');
  res.json(await markPaid({ orderId: b.razorpay_order_id, paymentId: b.razorpay_payment_id, source: 'checkout' }));
}));

billing.get('/orgs/:orgId/billing/payments', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100', [req.org.id]);
  res.json(rows);
}));

/** Public webhook: X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret). */
export const razorpayWebhook = Router();
razorpayWebhook.post('/razorpay', ah(async (req, res) => {
  const sig = req.get('x-razorpay-signature') || '';
  if (!config.razorpay.webhookSecret || !safeEqual(sig, hmacSha256Hex(config.razorpay.webhookSecret, req.rawBody || ''))) return res.sendStatus(401);
  const ev = req.body?.event;
  const pay = req.body?.payload?.payment?.entity;
  if ((ev === 'payment.captured' || ev === 'order.paid') && pay?.order_id) {
    try { await markPaid({ orderId: pay.order_id, paymentId: pay.id, source: 'webhook' }); } catch (e) { logger.warn({ err: e.message }, 'razorpay webhook: unknown order'); }
  }
  if (ev === 'payment.failed' && pay?.order_id) await query("UPDATE payments SET status = 'failed' WHERE rp_order_id = $1 AND status = 'created'", [pay.order_id]);
  return res.json({ ok: true });
}));
