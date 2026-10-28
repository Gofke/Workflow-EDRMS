/**
 * Applies the database migrations. Run before starting a new version:
 *   node dist/migrate.js        (or: npm run migrate)
 * The systemd unit runs it as ExecStartPre, so the schema is always current.
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { AppDataSource } from './config/data-source';

async function main() {
  await AppDataSource.initialize();
  const applied = await AppDataSource.runMigrations({ transaction: 'each' });
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}` : 'The database is up to date.');
  await AppDataSource.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
