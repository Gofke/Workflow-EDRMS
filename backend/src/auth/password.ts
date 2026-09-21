import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'crypto';

function scryptAsync(
  plain: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// Node's own scrypt is used deliberately: no native build step, so the same
// hashing works on every deployment target without a compiler present.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

/** Produces a self-describing hash: N:r:p:salt:key, all hex. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain, salt, KEY_LENGTH, { N, r: R, p: P });
  return `${N}:${R}:${P}:${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored value, so a damaged row cannot become an authentication bypass.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5) return false;

  const [n, r, p, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scryptAsync(plain, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
