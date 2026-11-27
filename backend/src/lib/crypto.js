import crypto from 'node:crypto';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { config } from '../config.js';

// Envelope encryption: random data key per secret, AES-256-GCM for the token.
// Production: data key is encrypted by AWS KMS (KMS_KEY_ID).
// Local/dev: data key is encrypted with TOKEN_ENC_KEY (32 bytes base64).
let kms;
function kmsClient() {
  if (!kms) kms = new KMSClient({ region: config.awsRegion });
  return kms;
}

function localKey() {
  if (!config.tokenEncKey) throw new Error('Set KMS_KEY_ID (prod) or TOKEN_ENC_KEY (dev) to store tokens');
  const k = Buffer.from(config.tokenEncKey, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64');
  return k;
}

function aesEncrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function aesDecrypt(key, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export async function encryptSecret(plaintext) {
  const dataKey = crypto.randomBytes(32);
  const body = aesEncrypt(dataKey, Buffer.from(plaintext, 'utf8'));
  let wrapped; let scheme;
  if (config.kmsKeyId) {
    const r = await kmsClient().send(new EncryptCommand({ KeyId: config.kmsKeyId, Plaintext: dataKey }));
    wrapped = Buffer.from(r.CiphertextBlob); scheme = 'kms';
  } else {
    wrapped = aesEncrypt(localKey(), dataKey); scheme = 'local';
  }
  return `${scheme}:${wrapped.toString('base64')}:${body.toString('base64')}`;
}

export async function decryptSecret(stored) {
  const [scheme, wrappedB64, bodyB64] = stored.split(':');
  const wrapped = Buffer.from(wrappedB64, 'base64');
  let dataKey;
  if (scheme === 'kms') {
    const r = await kmsClient().send(new DecryptCommand({ CiphertextBlob: wrapped }));
    dataKey = Buffer.from(r.Plaintext);
  } else if (scheme === 'local') {
    dataKey = aesDecrypt(localKey(), wrapped);
  } else {
    throw new Error('Unknown secret scheme');
  }
  return aesDecrypt(dataKey, Buffer.from(bodyB64, 'base64')).toString('utf8');
}

export function hmacSha256Hex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifyMetaSignature(appSecret, rawBody, header) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacSha256Hex(appSecret, rawBody));
}

/** Parse + verify a Meta signed_request (used by the data deletion callback). */
export function parseSignedRequest(signedRequest, appSecret) {
  if (!signedRequest || !signedRequest.includes('.')) return null;
  const [encodedSig, payload] = signedRequest.split('.', 2);
  const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = b64url(encodedSig);
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  const data = JSON.parse(b64url(payload).toString('utf8'));
  if (data.algorithm && data.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
  return data;
}

export const randomCode = (n = 10) => crypto.randomBytes(n).toString('hex');
