import { createHash } from 'crypto';

/**
 * Keeps environments apart (guide AU-28): a staging or local server refuses to
 * start when it is given a production secret or points at the production
 * database. The production server's install writes PRODUCTION_FINGERPRINTS on
 * the other environments: the first 16 hex characters of the SHA-256 of the
 * production AI key and of "host/database". Only fingerprints are stored, never
 * the secrets themselves.
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex').slice(0, 16);
}

/**
 * The Secure flag of the session cookie. Production always requires HTTPS.
 * Staging follows the connection ('auto': Secure when nginx forwards HTTPS), so
 * a staging site whose certificate could not be obtained yet still lets people
 * sign in. Development runs on plain http.
 */
export function sessionCookieSecure(env: NodeJS.ProcessEnv): boolean | 'auto' {
  if (env.NODE_ENV !== 'production') return false;
  return (env.APP_ENV ?? '').trim() === 'staging' ? 'auto' : true;
}

export function environmentProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const appEnv = (env.APP_ENV ?? 'development').trim();
  if (!['local', 'development', 'test', 'staging', 'production'].includes(appEnv)) {
    problems.push(`APP_ENV must be local, development, test, staging or production (is "${appEnv}").`);
  }
  if (appEnv !== 'production') {
    const known = new Set((env.PRODUCTION_FINGERPRINTS ?? '').split(',').map((f) => f.trim().toLowerCase()).filter(Boolean));
    if (known.size) {
      const key = env.AI_API_KEY?.trim();
      if (key && known.has(fingerprint(key))) problems.push(`This ${appEnv} server was given the production AI key. Use the ${appEnv} key.`);
      const db = `${env.DB_HOST ?? ''}/${env.DB_DATABASE ?? ''}`;
      if (known.has(fingerprint(db))) problems.push(`This ${appEnv} server points at the production database (${env.DB_DATABASE}).`);
    }
  }
  if (appEnv === 'production' && (env.SESSION_SECRET ?? '').length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters in production.');
  }
  return problems;
}
