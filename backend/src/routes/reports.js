import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { requireOrg } from '../lib/auth.js';
import { ah, parse } from './util.js';
import { buildMonthlyReport, createReportLink, currentMonth, orgForReportToken, reportPdf, monthLabel, summaryLine, previousMonth, pdfBuffer } from '../reports/monthly.js';
import { notifyOwner } from '../notify/whatsapp.js';
import { sendEmail } from '../notify/email.js';

const Month = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
const monthOf = (q) => parse(Month, q).month || currentMonth();

function sendPdf(res, r) {
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${r.business.replace(/[^\w-]+/g, '_')}_${r.month}_ads_report.pdf"`);
  reportPdf(r).pipe(res);
}

export const reports = Router();

reports.get('/orgs/:orgId/reports/monthly', requireOrg('viewer'), ah(async (req, res) => res.json(await buildMonthlyReport(req.org.id, monthOf(req.query)))));
reports.get('/orgs/:orgId/reports/monthly.pdf', requireOrg('viewer'), ah(async (req, res) => sendPdf(res, await buildMonthlyReport(req.org.id, monthOf(req.query)))));

reports.get('/orgs/:orgId/report-links', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT id, expires_at, revoked, created_at FROM report_links WHERE org_id = $1 ORDER BY id DESC LIMIT 20', [req.org.id]);
  res.json(rows);
}));
reports.post('/orgs/:orgId/report-links', requireOrg('manager'), ah(async (req, res) => {
  const { days } = parse(z.object({ days: z.number().int().min(1).max(365).default(90) }), req.body || {});
  res.status(201).json(await createReportLink(req.org.id, req.user.id, days));
}));
reports.delete('/orgs/:orgId/report-links/:id', requireOrg('manager'), ah(async (req, res) => {
  const r = await query('UPDATE report_links SET revoked = true WHERE id = $1 AND org_id = $2', [req.params.id, req.org.id]);
  if (!r.rowCount) throw notFound();
  res.json({ revoked: true });
}));

/** Public live report by share link (read-only, no login). */
export const publicReports = Router();
publicReports.get('/reports/:token', ah(async (req, res) => {
  const orgId = await orgForReportToken(req.params.token);
  if (!orgId) throw notFound('Ye report link expire ho gaya hai ya band kar diya gaya hai');
  res.set('cache-control', 'no-store');
  res.json(await buildMonthlyReport(orgId, monthOf(req.query)));
}));
publicReports.get('/reports/:token/pdf', ah(async (req, res) => {
  const orgId = await orgForReportToken(req.params.token);
  if (!orgId) throw notFound('Ye report link expire ho gaya hai ya band kar diya gaya hai');
  sendPdf(res, await buildMonthlyReport(orgId, monthOf(req.query)));
}));

/** 1st of month: last month's report -> stored, WhatsApp summary + live link, PDF by email. */
export async function sendMonthlyReport(orgId, month = previousMonth()) {
  const r = await buildMonthlyReport(orgId, month);
  if (!r.totals.spend && !r.totals.crmLeads) return { skipped: 'no activity' };
  const { rows: [done] } = await query('SELECT sent_at FROM monthly_reports WHERE org_id = $1 AND month = $2', [orgId, `${month}-01`]);
  if (done?.sent_at) return { skipped: 'already sent' };
  const { url } = await createReportLink(orgId, null, 60);
  await notifyOwner(orgId, `📊 *${r.business} — ${monthLabel(month)} report*\n${summaryLine(r)}\n\nPoori report (live): ${url}`);
  const { rows: owners } = await query("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role = 'owner'", [orgId]);
  const pdf = await pdfBuffer(r);
  for (const o of owners) {
    await sendEmail({ to: o.email, subject: `${r.business} — ${monthLabel(month)} ads report`, text: `${summaryLine(r)}\n\nLive report: ${url}`,
      attachments: [{ filename: `${month}_ads_report.pdf`, content: pdf, contentType: 'application/pdf' }] });
  }
  await query(`INSERT INTO monthly_reports (org_id, month, payload, sent_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (org_id, month) DO UPDATE SET payload = EXCLUDED.payload, sent_at = now()`, [orgId, `${month}-01`, JSON.stringify(r)]);
  return { sent: true, url };
}
