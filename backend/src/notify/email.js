import nodemailer from 'nodemailer';
import { logger } from '../lib/logger.js';

/**
 * Transactional email (password reset, invites, monthly report).
 * SMTP_URL e.g. smtps://user:pass@smtp.zoho.in:465 ; MAIL_FROM e.g. "Wayne Ads <no-reply@wayneesolutions.com>".
 * Not configured -> returns false so callers fall back to WhatsApp. Tests capture into `outbox`.
 */
export const outbox = [];
let transport;

export const emailConfigured = () => Boolean(process.env.SMTP_URL) || process.env.MAIL_MODE === 'log' || process.env.NODE_ENV === 'test';

export async function sendEmail({ to, subject, text, html, attachments }) {
  if (process.env.MAIL_MODE === 'log' || process.env.NODE_ENV === 'test') {
    outbox.push({ to, subject, text, html, attachments });
    logger.info({ to, subject }, 'email (log mode)');
    return true;
  }
  if (!process.env.SMTP_URL) return false;
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL);
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || 'Wayne Ads <no-reply@wayneesolutions.com>', to, subject, text, html, attachments });
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'email send failed');
    return false;
  }
}
