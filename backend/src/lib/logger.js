import pino from 'pino';
import { config } from '../config.js';

// Tokens / secrets must never reach logs: redact common paths.
export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'access_token', '*.access_token', 'token', '*.token', 'req.headers.authorization',
      'appsecret_proof', '*.appsecret_proof', 'headers.authorization', 'params.access_token',
    ],
    censor: '[redacted]',
  },
});
