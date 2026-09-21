import { BUILD_VERSION } from './version';
import 'reflect-metadata';
import dotenv from 'dotenv';
import { createApp } from './app-factory';

dotenv.config();

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`JusPol EDRMS API v${BUILD_VERSION} listening on port ${port}`);
}

void bootstrap();
