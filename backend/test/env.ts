/**
 * Loaded by Jest's setupFiles, before any application module is imported.
 *
 * Order matters: the TypeORM data source reads process.env when its module is
 * first imported, so .env.test must be in place before that happens. Loading it
 * inside a spec file would be too late.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

if (!process.env.DB_DATABASE?.includes('test')) {
  throw new Error(
    'Refusing to run: DB_DATABASE in .env.test must be a dedicated test database. ' +
      'The suite truncates tables. Copy .env.test.example to .env.test.',
  );
}
