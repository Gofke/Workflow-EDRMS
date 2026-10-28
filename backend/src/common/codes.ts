import { randomBytes } from 'crypto';

/**
 * A citizen's tracking code: eight characters without the ones people misread
 * (0/O, 1/I/L), shown as XXXX-XXXX.
 */
export function newTrackingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
