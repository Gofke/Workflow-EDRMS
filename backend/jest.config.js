/**
 * Integration tests run against a REAL PostgreSQL database, not a mock.
 *
 * Most of what this suite protects — the append-only audit rules, the registry
 * identity trigger, the unique index, the check constraints, the optimistic
 * version check — lives in the database. A mocked repository would report
 * success on every one of them while proving nothing.
 *
 * runInBand is required: the specs share one database and truncate between
 * files, so they must not run in parallel.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.spec\\.ts$',
  // Must run before any application module is imported. See test/env.ts.
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
};
