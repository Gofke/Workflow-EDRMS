import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import session from 'express-session';
import helmet from 'helmet';
import { AppModule } from './app.module';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PgSession = require('connect-pg-simple')(session);

/**
 * The session store owns its own PostgreSQL pool, separate from TypeORM's.
 * Closing the Nest application does not close it, which leaves the process
 * hanging — harmless for a long-running server, fatal for a test run. Kept here
 * so both callers can shut it down.
 */
let sessionStore: { close?: () => void } | null = null;

export function closeSessionStore(): void {
  sessionStore?.close?.();
  sessionStore = null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set. Copy .env.example to .env.`);
  }
  return value;
}

/**
 * Builds the application with its real middleware stack.
 *
 * main.ts and the integration tests both use this, deliberately: a test that
 * builds a different stack proves nothing about the deployed one. The session
 * cookie, the helmet headers and the validation pipe are all part of what the
 * suite verifies.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bodyParser: true, logger: false });
  const isProduction = process.env.NODE_ENV === 'production';
  const idleMinutes = Number(process.env.SESSION_IDLE_MINUTES ?? 30);

  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });

  app.use(
    session({
      name: 'juspol.sid',
      secret: requireEnv('SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      store: (sessionStore = new PgSession({
        conObject: {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
        },
        tableName: 'user_session',
        schemaName: 'public',
        createTableIfMissing: false,
      })) as never,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: idleMinutes * 60 * 1000,
      },
    }),
  );

  // whitelist strips unexpected fields; forbidNonWhitelisted rejects them
  // outright, so a client cannot submit values the API never declared.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  return app;
}
