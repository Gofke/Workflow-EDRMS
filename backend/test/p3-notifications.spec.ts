import { createECDH, randomBytes } from 'crypto';
import http from 'http';
import https from 'https';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AddressInfo } from 'net';
import { SMTPServer } from 'smtp-server';
import { DeadlinesService } from '../src/deadlines/deadlines.service';
import { NotificationService } from '../src/core/notification.service';
import { WorkingDaysService } from '../src/core/working-days.service';
import { SettingsService } from '../src/settings/settings.service';
import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Notifications, delivery channels, the working-day calendar, reminders,
 * escalation, the daily summary and the weekly overview.
 */
describe('Phase 3 notifications and deadlines', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.post('/api/calendar/holidays/load-suriname').expect(200);
  });
  afterAll(async () => {
    await h.close();
  });

  const svc = <T>(type: new (...args: never[]) => T): T => h.app.get(type as never);

  it('counts Suriname working days around weekends and public holidays', async () => {
    const wd = svc(WorkingDaysService);
    wd.invalidate();
    // Thursday 24 December 2026 + 1 working day: Christmas and Boxing Day, then a weekend.
    expect(await wd.addWorkingDays('2026-12-24', 1)).toBe('2026-12-28');
    expect(await wd.workingDaysBetween('2026-12-24', '2026-12-28')).toBe(1);
    expect(await wd.isWorkingDay('2026-11-25')).toBe(false); // Srefidensi
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const r = (await agent.get('/api/calendar/working-days?from=2026-12-24&days=1').expect(200)).body;
    expect(r.date).toBe('2026-12-28');
    const holidays = (await agent.get('/api/calendar/holidays?year=2026').expect(200)).body;
    expect(holidays.find((x: { date: string }) => x.date === '2026-07-01').name).toContain('Keti Koti');
  });

  it('lists, reads and marks all notifications for the person only', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const clerk = await accountIdFor(h.db, 'assistant1@juspol.test');
    await directeur.post('/api/tasks').send({ title: 'Melding test', assigneeAccountId: clerk }).expect(201);
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const list = (await agent.get('/api/notifications').expect(200)).body;
    expect(list.unread).toBeGreaterThan(0);
    await agent.post(`/api/notifications/${list.items[0].id}/read`).expect(200);
    // Someone else cannot mark it.
    await directeur.post(`/api/notifications/${list.items[0].id}/read`).expect(200);
    await agent.post('/api/notifications/read-all').send({}).expect(200);
    expect((await agent.get('/api/notifications').expect(200)).body.unread).toBe(0);
  });

  it('follows the person’s channel preferences and writes e-mail to the outbox', async () => {
    const { agent } = await signIn(h.app, 'assistant2@juspol.test');
    await agent.put('/api/notifications/preferences').send({ kinds: { TASK_ASSIGNED: { email: false } } }).expect(200);
    const prefs = (await agent.get('/api/notifications/preferences').expect(200)).body;
    expect(prefs.kinds.TASK_ASSIGNED.email).toBe(false);
    const me = await accountIdFor(h.db, 'assistant2@juspol.test');
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    await directeur.post('/api/tasks').send({ title: 'Zonder mail', assigneeAccountId: me }).expect(201);
    const mails = await h.db.query(`SELECT 1 FROM email_outbox WHERE account_id = $1 AND subject LIKE '%Zonder mail%'`, [me]);
    expect(mails).toHaveLength(0);
    const clerk = await accountIdFor(h.db, 'assistant1@juspol.test');
    await directeur.post('/api/tasks').send({ title: 'Met mail', assigneeAccountId: clerk }).expect(201);
    const queued = await h.db.query(`SELECT status, body_html FROM email_outbox WHERE account_id = $1 AND subject LIKE '%Met mail%'`, [clerk]);
    expect(queued[0].status).toBe('QUEUED');
    expect(queued[0].body_html).toContain('Ministerie van Justitie en Politie');
    await svc(NotificationService).flush();
    const [logged] = await h.db.query(`SELECT status FROM email_outbox WHERE account_id = $1 AND subject LIKE '%Met mail%'`, [clerk]);
    expect(logged.status).toBe('LOGGED');
  });

  it('delivers real e-mail through an SMTP server when one is configured', async () => {
    const received: string[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        let data = '';
        stream.on('data', (c) => (data += c.toString()));
        stream.on('end', () => {
          received.push(data);
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    const port = (smtp.server.address() as AddressInfo).port;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.SMTP_FROM = 'JusPol EDRMS <noreply@juspol.test>';
    try {
      const notifications = svc(NotificationService);
      await notifications.queueEmail(null, 'test@juspol.test', 'SMTP proef', 'Tekst', '<p>Tekst</p>', 'SYSTEM');
      await notifications.flush();
      const [row] = await h.db.query(`SELECT status FROM email_outbox WHERE subject = 'SMTP proef'`);
      expect(row.status).toBe('SENT');
      expect(received.join('')).toContain('Subject: SMTP proef');
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_PORT;
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    }
  });

  it('sends SMS through an HTTP gateway for urgent kinds, when switched on and a number is known', async () => {
    const bodies: string[] = [];
    const gateway = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        bodies.push(`${req.headers.authorization} ${data}`);
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    process.env.SMS_PROVIDER = 'http';
    process.env.SMS_HTTP_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/send`;
    process.env.SMS_HTTP_TOKEN = 'gateway-token';
    try {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      await admin.put('/api/settings/notifications').send({ value: { smsEnabled: true } }).expect(200);
      svc(SettingsService).invalidate();
      const { agent } = await signIn(h.app, 'minister@juspol.test');
      await agent.put('/api/notifications/preferences').send({ mobileNumber: '+597 8123456' }).expect(200);
      const minister = await accountIdFor(h.db, 'minister@juspol.test');
      const notifications = svc(NotificationService);
      await notifications.notify({ recipients: [minister], kind: 'DEADLINE_ESCALATION', params: { label: 'DOS-X', days: 2, due: '01-11-2026', person: 'A' } });
      await notifications.flush();
      expect(bodies[0]).toContain('Bearer gateway-token');
      expect(bodies[0]).toContain('+5978123456');
      const [row] = await h.db.query(`SELECT status FROM sms_outbox WHERE to_number = '+5978123456'`);
      expect(row.status).toBe('SENT');
      await admin.put('/api/settings/notifications').send({ value: { smsEnabled: false } }).expect(200);
    } finally {
      delete process.env.SMS_PROVIDER;
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });

  it('sends an encrypted web-push message signed with the server’s VAPID key', async () => {
    const pushes: { headers: http.IncomingHttpHeaders; length: number }[] = [];
    // Push services are HTTPS-only; a local stand-in with its own certificate.
    const dir = mkdtempSync(join(tmpdir(), 'push-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    process.env.PUSH_EXTRA_CA_FILE = join(dir, 'cert.pem');
    const service = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        pushes.push({ headers: req.headers, length: Buffer.concat(chunks).length });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const { agent } = await signIn(h.app, 'onderdirecteur@juspol.test');
      const key = (await agent.get('/api/notifications/push/public-key').expect(200)).body.publicKey;
      expect(key.length).toBeGreaterThan(40);
      await agent
        .post('/api/notifications/push/subscribe')
        .send({
          endpoint: `https://127.0.0.1:${(service.address() as AddressInfo).port}/push/abc`,
          keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
        })
        .expect(201);
      const result = (await agent.post('/api/notifications/push/test').expect(200)).body;
      expect(result.sent).toBe(1);
      expect(pushes[0].headers.authorization).toMatch(/^vapid t=/);
      expect(pushes[0].headers['content-encoding']).toBe('aes128gcm');
      expect(pushes[0].length).toBeGreaterThan(50);
    } finally {
      delete process.env.PUSH_EXTRA_CA_FILE;
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });

  it('copies a notification to the stand-in of someone who is away', async () => {
    const away = await accountIdFor(h.db, 'directeur@juspol.test');
    const standIn = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await h.db.query(
      `INSERT INTO out_of_office (account_id, starts_on, ends_on, stand_in_account_id, message)
       VALUES ($1, current_date - 1, current_date + 5, $2, 'Op dienstreis')`,
      [away, standIn],
    );
    await svc(NotificationService).notify({ recipients: [away], kind: 'SYSTEM', params: { title: 'Vervangingstest', body: '' } });
    const [copy] = await h.db.query(`SELECT title, for_absent_account_id FROM notification WHERE account_id = $1 AND title LIKE '%Vervangingstest%'`, [standIn]);
    expect(copy.title).toContain('Voor M. Sardjoe');
    expect(copy.for_absent_account_id).toBe(away);
    await h.db.query(`UPDATE out_of_office SET ended_at = now() WHERE account_id = $1`, [away]);
  });

  it('reminds before a deadline once, then escalates to the supervisor and the level above', async () => {
    const wd = svc(WorkingDaysService);
    const deadlines = svc(DeadlinesService);
    const clerk = await accountIdFor(h.db, 'assistant2@juspol.test');
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    const minister = await accountIdFor(h.db, 'minister@juspol.test');
    // Structure: the clerk's unit (Directoraat) is headed by the Directeur, under the Kabinet headed by the Minister.
    await h.db.query(`UPDATE organisational_unit SET head_account_id = $1, parent_unit_id = (SELECT id FROM organisational_unit WHERE code = 'HO-KAB') WHERE code = 'HO-DIR'`, [directeur]);
    await h.db.query(`UPDATE organisational_unit SET head_account_id = $1 WHERE code = 'HO-KAB'`, [minister]);
    const today = '2026-11-02'; // a Monday
    const due = await wd.addWorkingDays(today, 2);
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const task = (await agent.post('/api/tasks').send({ title: 'Termijntest', assigneeAccountId: clerk, dueDate: '2099-01-01' }).expect(201)).body;
    await h.db.query(`UPDATE task SET due_date = $2 WHERE id = $1`, [task.id, due]);

    const first = await deadlines.run(today);
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    const again = await deadlines.run(today);
    expect(again.reminders).toBe(0);
    const [reminder] = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND kind = 'DEADLINE_REMINDER' AND title LIKE '%Termijntest%'`, [clerk]);
    expect(reminder.title).toContain('2 werkdag');

    // Two working days after the deadline: overdue notice and first escalation.
    const later = await wd.addWorkingDays(due, 2);
    const late = await deadlines.run(later);
    expect(late.overdue).toBeGreaterThanOrEqual(1);
    const [esc] = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND kind = 'DEADLINE_ESCALATION' AND title LIKE '%Termijntest%'`, [directeur]);
    expect(esc.title).toContain('Escalatie');
    await expectAuditEvent(h.db, 'DEADLINE_ESCALATED', 'Termijntest');
    // Five more working days: the level above hears too.
    const muchLater = await wd.addWorkingDays(later, 5);
    await deadlines.run(muchLater);
    const second = await h.db.query(`SELECT 1 FROM notification WHERE account_id = $1 AND kind = 'DEADLINE_ESCALATION' AND title LIKE '%Termijntest%'`, [minister]);
    expect(second.length).toBe(1);
  });

  it('sends the daily summary to someone who chose it, instead of single e-mails', async () => {
    const { agent } = await signIn(h.app, 'unauthorised@juspol.test');
    await agent.put('/api/notifications/preferences').send({ emailMode: 'DIGEST' }).expect(200);
    const me = await accountIdFor(h.db, 'unauthorised@juspol.test');
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    await directeur.post('/api/tasks').send({ title: 'Digest A', assigneeAccountId: me }).expect(201);
    await directeur.post('/api/tasks').send({ title: 'Digest B', assigneeAccountId: me }).expect(201);
    const single = await h.db.query(`SELECT 1 FROM email_outbox WHERE account_id = $1 AND subject LIKE '%Digest%'`, [me]);
    expect(single).toHaveLength(0);
    const result = await svc(DeadlinesService).sendDigests();
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const [digest] = await h.db.query(`SELECT subject, body_text FROM email_outbox WHERE account_id = $1 AND kind = 'DIGEST'`, [me]);
    expect(digest.subject).toMatch(/Dagoverzicht: \d+ melding/);
    expect(digest.body_text).toContain('Digest A');
  });

  it('sends the weekly overview to decision-makers and runs jobs on request', async () => {
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    const result = (await admin.post('/api/admin/jobs/weekly-report/run').expect(200)).body;
    expect(result.sent).toBeGreaterThanOrEqual(3);
    const minister = await accountIdFor(h.db, 'minister@juspol.test');
    const [note] = await h.db.query(`SELECT body FROM notification WHERE account_id = $1 AND kind = 'WEEKLY_REPORT'`, [minister]);
    expect(note.body).toContain('Afgelopen week');
    const jobs = (await admin.get('/api/admin/jobs').expect(200)).body;
    expect(jobs[0].job).toBe('weekly-report');
    expect(jobs[0].finishedAt).not.toBeNull();
    const outbox = (await admin.get('/api/admin/outbox/email').expect(200)).body;
    expect(outbox.length).toBeGreaterThan(0);
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.get('/api/admin/outbox/email').expect(403);
  });

  it('tells the reviewer, then the submitter, as a matter moves through review', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await clerk.post('/api/dossiers').send({ subject: 'Review notifications' }).expect(201)).body;
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    const [{ version }] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossier.id]);
    await clerk.post(`/api/dossiers/${dossier.id}/submit`).send({ reviewerAccountId: directeur, version }).expect(200);
    const [asked] = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND kind = 'REVIEW_REQUESTED' AND subject_id = $2`, [directeur, dossier.id]);
    expect(asked.title).toContain(dossier.dossierIdentity);
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const [{ version: v2 }] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossier.id]);
    await dir.post(`/api/dossiers/${dossier.id}/return`).send({ reason: 'Bijlage ontbreekt', version: v2 }).expect(200);
    const clerkId = await accountIdFor(h.db, 'assistant1@juspol.test');
    const [returned] = await h.db.query(`SELECT body FROM notification WHERE account_id = $1 AND kind = 'MATTER_RETURNED' AND subject_id = $2`, [clerkId, dossier.id]);
    expect(returned.body).toContain('Bijlage ontbreekt');
  });
});
