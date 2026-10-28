import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238) — what an authenticator app such as
 * Google Authenticator, Microsoft Authenticator or FreeOTP shows.
 *
 * SHA-1, 30-second steps, six digits: the parameters every authenticator app
 * supports. One step either side is accepted to allow for a phone clock that
 * is slightly off, and the step last used is remembered so the same code
 * cannot be used twice.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[=\s]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Returns the matching step, or null. Never accepts a step at or before lastUsedStep. */
export function verifyCode(secret: string, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  const candidate = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastUsedStep !== null && s <= lastUsedStep) continue;
    const expected = codeForStep(secret, s);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * The secret is encrypted at rest with AES-256-GCM. The key comes from
 * MFA_ENCRYPTION_KEY, falling back to the session secret, so a database copy on
 * its own does not reveal anyone's second factor.
 */
function key(): Buffer {
  const material = process.env.MFA_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (!material) throw new Error('MFA_ENCRYPTION_KEY or SESSION_SECRET must be set.');
  return createHash('sha256').update(`juspol-mfa:${material}`).digest();
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(':').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function recoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(6)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
