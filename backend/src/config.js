import 'dotenv/config';

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';

export const config = {
  env,
  isProd: env === 'production',
  isTest,
  port: Number(process.env.PORT || 4100),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4100',
  appUrl: process.env.APP_URL || 'http://localhost:5173',

  databaseUrl: req('DATABASE_URL', isTest ? 'postgres://localhost/wayne_ads_test' : undefined),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  jwtSecret: req('JWT_SECRET', isTest ? 'test-secret' : undefined),

  // Token encryption: in production use AWS KMS (KMS_KEY_ID). Locally a 32-byte
  // base64 key in TOKEN_ENC_KEY is used instead. Never both empty.
  kmsKeyId: process.env.KMS_KEY_ID || '',
  awsRegion: process.env.AWS_REGION || 'ap-south-1',
  tokenEncKey: process.env.TOKEN_ENC_KEY || '',

  meta: {
    // Always the latest stable Graph API version. Change it here (.env), never in code.
    apiVersion: req('META_API_VERSION', 'v25.0'),
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    // Phase 1 agency mode: Wayne Business Manager system user token.
    systemUserToken: process.env.META_SYSTEM_USER_TOKEN || '',
    businessId: process.env.META_BUSINESS_ID || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    // Phase 2 self-serve: Facebook Login for Business configuration id.
    loginConfigId: process.env.META_LOGIN_CONFIG_ID || '',
    graphBase: process.env.META_GRAPH_BASE || 'https://graph.facebook.com',
    // Set to "1" to never send write calls to Meta (rules dry-run is separate).
    writesDisabled: process.env.META_WRITES_DISABLED === '1',
  },

  whatsapp: {
    // Loopdesk WhatsApp number (Meta app loopdeskai).
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
    accessToken: process.env.WA_ACCESS_TOKEN || '',
    appSecret: process.env.WA_APP_SECRET || '',
    verifyToken: process.env.WA_VERIFY_TOKEN || '',
    templatePrefix: process.env.WA_TEMPLATE_PREFIX || 'loopdesk',
    // "log" prints messages instead of sending (dev / tests).
    mode: process.env.WA_MODE || (isTest ? 'log' : 'live'),
  },

  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-sonnet-5-5',
  },

  crm: {
    // Loopdesk AI Jobs (CRM-HCM) API, e.g. https://crm-hcm.wayneesolutions.com/api/v1
    baseUrl: process.env.JOBS_CRM_API_URL || '',
    apiKey: process.env.JOBS_CRM_API_KEY || '',
    webhookSecret: process.env.JOBS_CRM_WEBHOOK_SECRET || '',
  },

  wayneRing: {
    baseUrl: process.env.WAYNERING_API_URL || '',
    apiKey: process.env.WAYNERING_API_KEY || '',
  },

  rules: {
    // Spec: 2 weeks of dry run first. Default ON until someone flips it.
    dryRun: process.env.RULES_DRY_RUN !== '0',
  },

  gstRate: Number(process.env.GST_RATE || 0.18),
};
