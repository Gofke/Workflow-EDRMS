import { BUILD_VERSION } from './version';
import 'reflect-metadata';
import dotenv from 'dotenv';
import { createApp } from './app-factory';
import { environmentProblems } from './config/environment-guard';

dotenv.config();

async function bootstrap(): Promise<void> {
  const problems = environmentProblems(process.env);
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`JusPol EDRMS API v${BUILD_VERSION} listening on port ${port}`);
}

void bootstrap();
