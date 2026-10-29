# JusPol EDRMS — V0.3.0 (Phase 3)

Records, case and task management for the Ministry of Justice and Police,
Suriname. Phase 3 merges the two earlier panels into one system:

- **Workflow EDRMS** (Delivery 1, V0.1.18): registration of post, dossiers,
  responsibility and deadlines, approval workflow, delegation, document
  integrity, timeline, audit. It is the foundation; its rules and tests are kept.
- **Workflow Task Management**: tasks, checklists, subtasks, comments,
  attachments, board and calendar, templates, reminders. Rebuilt inside the
  EDRMS so tasks belong to the same letters and matters, the same permissions
  and the same audit log.

On top of both, Phase 3 adds a free built-in assistant (AI), management
dashboards and reports, search across scanned text, approval routes, advice
requests, out-of-office stand-ins, a file plan with retention and legal hold,
an audit viewer with a nightly integrity check, links with WijSamen, the mail
server and other ministries, notifications by e-mail, SMS and push, and an
installable app for phones and tablets. The interface is Dutch, with English
available, and has light, dark and high-contrast themes.

The feature document `JusPol-EDRMS-V0.3.0-Features.pdf` describes every
feature with a screenshot. This README is for whoever installs and runs it.

| | |
|---|---|
| Backend | NestJS 10, TypeScript, PostgreSQL 16, TypeORM migrations |
| Frontend | React 18, TypeScript, Vite; installable PWA |
| Sessions | Server-side in PostgreSQL, HttpOnly + Secure cookie, optional two-step verification |
| Seals | Ed25519 system seal with QR code and public check page |
| Assistant | Built-in engine (no internet, no subscription); optional local Ollama model |
| Documents | Content-addressed storage (SHA-256), OCR in Dutch and English, virus scan hook |

## The assistant (AI) — free and on the ministry's own server

The built-in assistant needs no internet connection, no account and no
subscription. It reads only what the person asking may see, proposes, and
leaves every decision to a person; each suggestion and what was done with it
is recorded. It can:

- chat on every page: what is waiting for me, find letters and matters,
  summarise a matter, draft a reply, prepare a task, explain the system;
- answer questions in plain Dutch or English ("Welke brieven van de Politie
  kwamen deze maand binnen?");
- propose registration fields from a scan, recognise deadlines in working days
  (Surinamese holidays included), spot near-duplicate letters and suggest the
  handling department;
- flag matters at risk of missing their deadline, with the reasons;
- turn meeting notes into tasks for the right people.

Optionally, the administrator connects a free open-source model running on a
ministry server (Ollama with e.g. Llama or Mistral) under **Beheer → Assistent**.
It then writes more fluently and can translate. The built-in engine stays the
fallback. An external paid service can also be chosen, but confidential and
secret records never go to it.

## Installing

Requires Node.js 20+, PostgreSQL 14+ (16 tested), and on the server:
`poppler-utils` (pdftotext, pdftoppm), `tesseract-ocr` with `tesseract-ocr-nld`
for OCR, and ClamAV (`clamdscan`) for virus scanning in production.

### 1. Database

```sql
CREATE USER juspol WITH PASSWORD '<strong password>';
CREATE DATABASE juspol_edrms OWNER juspol;
\c juspol_edrms
GRANT ALL ON SCHEMA public TO juspol;
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # fill in — every setting is explained in the file
npm ci
npm run build
npm run migrate             # applies all migrations (also runs on every service start)
npm run seed                # the pilot accounts (test environments only)
npm start
```

At minimum set `DB_PASSWORD`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL`, `CORS_ORIGIN`, `NODE_ENV=production` and `TRUST_PROXY=1`.
The keys folder (`KEYS_DIR`) is created on first start and holds the sealing
key: **back it up with the database and the document folder.**

### 3. Frontend

```bash
cd frontend
npm ci
npm run build               # output in frontend/dist
```

### 4. Web server, service, backups

- `deploy/nginx.conf.example` and `deploy/juspol-security-headers.conf` — nginx
  with TLS, security headers (HSTS, CSP), the app and `/api/` proxy. Tested with
  nginx 1.24 and a production build: secure cookie, service worker and PDF
  viewer work under the content security policy.
- `deploy/juspol-api.service` — systemd unit; migrations run before each start.
- `deploy/backup.sh` / `deploy/restore.sh` — database, documents and keys, with
  checksums and optional AES-256 encryption (`BACKUP_PASSPHRASE`).
  `deploy/test-backup-restore.sh` backs up, restores into a separate database
  and proves the copy is identical (rows, every file's SHA-256, audit chain).

Check `https://<server>/api/health`:
`{"status":"ok","version":"0.3.0","database":"reachable"}`.

## Demonstration data

```bash
cd backend
npm run seed:demo -- --reset   # ERASES the database in .env — never on a live system
```

Builds a realistic ministry through the application's own API: 11
departments and offices, 19 accounts, 66 letters with their documents (scans read by OCR),
25 matters with decisions, 29 tasks, advice, replies with seals, WijSamen
reports and an exchange with another ministry, spread over ten months. All
people and letters are invented. Every account uses the `SEED_PASSWORD`.

| Account | Role |
|---|---|
| minister@juspol.test | Minister (R. Dijkstra) |
| directeur@juspol.test | Directeur (M. Sardjoe) |
| onderdirecteur@juspol.test | Onder-Directeur (A. Boldewijn) |
| dualrole@juspol.test | Onder-Directeur and staff (S. Hiwat) |
| assistant1@juspol.test, assistant2@juspol.test | Registry and Cabinet staff |
| kartodikromo@, sabajo@, chin@, vlijter@, ramdin@, pengel@juspol.test | Heads of department |
| wongsodikromo@, doekhie@, oemrawsingh@juspol.test | Department staff |
| kensmil@juspol.test | Former staff member (account switched off) |
| linger@juspol.test | Records manager (archive) |
| auditor@juspol.test | Internal auditor |
| sysadmin@juspol.test | System administrator (no access to record content) |

## Tests

```bash
cd backend && cp .env.test.example .env.test && npm test    # integration suite, real PostgreSQL
cd frontend && npm test                                     # component tests
```

The integration suite runs against a real, dedicated test database, because
much of what it protects (append-only audit rules, the hash chain, triggers,
constraints) lives in the database. 24 spec files cover authentication,
administration, registration, dossiers, documents, delegation, workflow,
timeline, tasks, approvals, case files, letters and seals, notifications,
search and dashboards, the assistant, oversight and integrations. The
component tests check that each screen offers the right controls to the right
person and sends what the person chose.

## Security notes

- The Task Management repository contained a committed Firebase service
  account key. It is not used here and must be **revoked in the Google Cloud
  console**; treat it as exposed.
- No secrets are stored in the database or in this repository: `.env`, the
  keys folder and the document folders are excluded.
- System administration never grants access to record content; the auditor
  reads the log, not the records.

## Repository layout

```
backend/src/records, documents, workflow, delegation, timeline   Delivery 1 core
backend/src/tasks, approvals, casefiles, letters, deadlines       Phase 3 work
backend/src/ai                     the assistant: engine/ (built-in), llm.ts (optional model)
backend/src/oversight, integrations, dashboard, search, security  oversight and links
backend/src/migrations             schema history, the only way the schema changes
backend/src/seed                   pilot accounts and demonstration data
backend/test                       integration suite
frontend/src/pages, shell, ui      the interface; *.test.tsx component tests
deploy/                            nginx, systemd, backup and restore
docs/                              delivery notes and tester guides
```
