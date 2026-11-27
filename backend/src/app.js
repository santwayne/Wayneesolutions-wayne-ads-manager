import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import { requireAuth } from './lib/auth.js';
import { MetaApiError } from './meta/graph.js';
import { auth } from './routes/auth.js';
import { orgs } from './routes/orgs.js';
import { wizard } from './routes/wizard.js';
import { ops } from './routes/ops.js';
import { metaLogin } from './routes/metaLogin.js';
import { metaWebhooks, deletionStatus } from './webhooks/meta.js';
import { whatsappWebhooks } from './webhooks/whatsapp.js';
import { crmWebhooks } from './webhooks/crm.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.appUrl, credentials: false }));
  // Keep the raw body: webhook signatures are computed over the exact bytes.
  const keepRaw = (req, _res, buf) => { req.rawBody = buf.toString('utf8'); };
  app.use(express.json({ limit: '2mb', verify: keepRaw }));
  app.use(express.urlencoded({ extended: false, verify: keepRaw })); // data deletion signed_request

  app.get('/health', (_req, res) => res.json({ ok: true, apiVersion: config.meta.apiVersion }));

  // Public webhooks (signature-checked inside)
  app.use('/webhooks', metaWebhooks, whatsappWebhooks, crmWebhooks);
  app.get('/deletion-status', (req, res, next) => deletionStatus(req, res).catch(next));
  app.get('/meta/callback', (req, res, next) => metaLogin.handle(req, res, next));

  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, max: 50 }), auth);
  app.use('/api', requireAuth, orgs, wizard, ops, metaLogin);

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    if (err instanceof MetaApiError) {
      logger.warn({ code: err.code, sub: err.subcode, trace: err.fbtraceId }, 'meta error');
      return res.status(502).json({ error: 'meta_error', message: err.userTitle ? `${err.userTitle}: ${err.message}` : err.message, code: err.code });
    }
    logger.error({ err: err.message, stack: err.stack, path: req.path }, 'unhandled');
    return res.status(500).json({ error: 'internal', message: 'Kuch gadbad ho gayi, team ko pata chal gaya hai' });
  });
  return app;
}
