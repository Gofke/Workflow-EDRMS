import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import nodemailer, { Transporter } from 'nodemailer';
import webpush from 'web-push';

/**
 * Outbound channels. Each works without the outside world by default — e-mail
 * and SMS are written to their outbox as LOGGED, so a demonstration server
 * shows exactly what would have been sent — and each switches to real delivery
 * when its connection details are set in the environment:
 *
 *   E-mail  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_SECURE
 *   SMS     SMS_PROVIDER=http  with SMS_HTTP_URL and SMS_HTTP_TOKEN (any gateway
 *           that accepts a JSON POST, e.g. a Telesur or Digicel business API)
 *           SMS_PROVIDER=twilio with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *   Push    VAPID keys are generated on first start and kept in KEYS_DIR.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger('Mailer');
  private transporter: Transporter | null = null;

  get mode(): 'smtp' | 'log' {
    return process.env.SMTP_HOST ? 'smtp' : 'log';
  }

  private transport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
        tls: { rejectUnauthorized: process.env.SMTP_TLS_INSECURE !== 'true' },
      });
    }
    return this.transporter;
  }

  async send(to: string, subject: string, text: string, html?: string | null): Promise<'SENT' | 'LOGGED'> {
    if (this.mode === 'log') return 'LOGGED';
    await this.transport().sendMail({
      from: process.env.SMTP_FROM ?? 'JusPol EDRMS <no-reply@juspol.local>',
      to,
      subject,
      text,
      html: html ?? undefined,
    });
    return 'SENT';
  }
}

@Injectable()
export class SmsSender {
  get mode(): 'http' | 'twilio' | 'log' {
    const p = process.env.SMS_PROVIDER;
    return p === 'http' || p === 'twilio' ? p : 'log';
  }

  async send(to: string, body: string): Promise<'SENT' | 'LOGGED'> {
    if (this.mode === 'log') return 'LOGGED';
    if (this.mode === 'http') {
      const response = await fetch(process.env.SMS_HTTP_URL as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.SMS_HTTP_TOKEN ? { Authorization: `Bearer ${process.env.SMS_HTTP_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to, message: body }),
      });
      if (!response.ok) throw new Error(`SMS gateway answered ${response.status}`);
      return 'SENT';
    }
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM as string, Body: body }).toString(),
    });
    if (!response.ok) throw new Error(`Twilio answered ${response.status}`);
    return 'SENT';
  }
}

export function keysDir(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

@Injectable()
export class PushSender {
  private readonly logger = new Logger('PushSender');
  private keys: { publicKey: string; privateKey: string } | null = null;

  vapid(): { publicKey: string; privateKey: string } {
    if (this.keys) return this.keys;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      this.keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    } else {
      const file = join(keysDir(), 'vapid.json');
      if (existsSync(file)) {
        this.keys = JSON.parse(readFileSync(file, 'utf8'));
      } else {
        this.keys = webpush.generateVAPIDKeys();
        writeFileSync(file, JSON.stringify(this.keys), { mode: 0o600 });
      }
    }
    return this.keys as { publicKey: string; privateKey: string };
  }

  async send(subscription: { endpoint: string; p256dh: string; auth: string }, payload: object): Promise<void> {
    const keys = this.vapid();
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: process.env.VAPID_SUBJECT ?? 'mailto:ict@juspol.local',
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 3600,
      },
    );
  }
}
