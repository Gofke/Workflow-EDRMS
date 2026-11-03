# JusPol EDRMS — V0.5.1

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

V0.4.0 adds **"Vraag de assistent"**: a chat panel like ChatGPT on every page,
on Google Gemini (free tier first), that answers any question about the work
from the live data — but only what the person may see, within their line of
command: the Minister about the whole ministry, a Directeur about the
directorate, an Onder-Directeur about the sub-directorate, a head of
department and an employee about their department. The organisation now has
sub-directorates (Minister → directorates → sub-directorates → departments →
employees).

V0.5.0 adds **projects**: from business case to handover. Each project has an
owner (opdrachtgever), a project manager (projectleider), stakeholders and
team members. The project manager writes the business case; the owner
approves it or sends it back with a reason. Approval closes the first phase
and opens the next. The work is divided into tickets per phase, shown on a
Gantt chart, and the owner signs off the last phase. Access is need-to-know:
a team member, such as an external contractor, sees only their own tickets; a
stakeholder sees the business case and the phases but not the tickets; the
line of command sees status and progress; a confidential project is visible
only to the people on it. The assistant answers questions about projects
within the same rules, and never sends project names, ticket titles or
anything from a confidential project to the AI provider.

The feature document `JusPol-EDRMS-V0.4.0-Features.pdf` describes every
feature with a screenshot. This README is for whoever installs and runs it.

| | |
|---|---|
| Backend | NestJS 10, TypeScript, PostgreSQL 16, TypeORM migrations |
| Frontend | React 18, TypeScript, Vite; installable PWA |
| Sessions | Server-side in PostgreSQL, HttpOnly + Secure cookie, optional two-step verification |
| Seals | Ed25519 system seal with QR code and public check page |
| Projects | Business case gate, phases (3–8) with tickets, Gantt chart, need-to-know access per project role |
| Assistant | Chat panel on Google Gemini (free tier) with role- and line-filtered read-only tools; built-in offline engine as fallback; Ollama, OpenAI-compatible or Anthropic by settings |
| Documents | Content-addressed storage (SHA-256), OCR in Dutch and English, virus scan hook |

## The assistant (AI)

### "Vraag de assistent" — the panel (V0.4.0)

Ask anything, in Dutch or English: *Wat staat er vandaag voor mij klaar?*,
*Hoeveel open zaken heeft elke afdeling in mijn directoraat?*, *Welke zaken
lopen risico?*, *Wie werkt er bij Juridische Zaken?*, *Hoe registreer ik een
brief?*. The model (Gemini) decides which read-only tools to use; the tools
run on the ministry server **as the person asking**, with the same permission
rules as the screens plus the person's line of command. Answers are shown as
safe Markdown with cards that link to the records.

What reaches Google on the free tier: numbers, statuses, dates, deadlines,
unit names and the names of the officials handling the work. Never subjects,
senders, document text or confidential records — those are shown to the
person in cards by the server itself. Phone numbers, e-mail addresses and ID
numbers typed into a question are removed before it is sent. The audit log
records who asked, when, which tools ran and the result — never the question.

Turning it on:

1. Get a key in Google AI Studio (free).
2. On the server, in the settings file (never in git, the database or a document):
   ```
   AI_PROVIDER=gemini
   AI_MODEL=gemini-flash-latest
   AI_FALLBACK_MODELS=gemini-flash-lite-latest
   AI_API_KEY=<the key>
   ```
3. Restart the API. Under **Beheer → Assistent** tick "Assistentpaneel (vraag alles)".
   The screen shows which values the server fixes and whether a key is present.

Without a key the panel still works with the built-in offline assistant. To
switch the AI off at once, remove `AI_API_KEY` and restart. Limits: 30
questions per person per hour (setting), 60 requests per address per minute,
6 tool rounds and 80 seconds per question.

Documents: `docs/ai/BUSINESS-DOCUMENT.md`, `docs/ai/DESIGN.md` (role → tool
matrix, data classes, API contract), `docs/ai/AUDIT.md` (audit document and
scenarios AU-01…AU-35), `docs/ai/EVALUATION.md` (40 + 40 questions) and the
tester sheet `docs/JusPol-EDRMS-V0.4.0-AI-Tester-Sheet.xlsx`.

### The built-in assistant — free and on the ministry's own server

The built-in assistant needs no internet connection, no account and no
subscription. It reads only what the person asking may see, proposes, and
leaves every decision to a person; each suggestion and what was done with it
is recorded. It answers in the panel when no language model is configured or
reachable, and it handles requests that propose a change (a task, tasks from
meeting notes) so that nothing happens without confirmation. It can also:

- propose registration fields from a scan, recognise deadlines in working days
  (Surinamese holidays included), spot near-duplicate letters and suggest the
  handling department;
- summarise a matter, draft a reply, flag matters at risk of missing their
  deadline, turn meeting notes into tasks.

Optionally, the administrator connects a free open-source model on a ministry
server (Ollama with e.g. Llama or Mistral) under **Beheer → Assistent**; then
open and internal records may also be sent to it (data policy "records").
Confidential and secret records never go to a model outside the network.

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

- `deploy/pack.sh` builds a release; `deploy/install.sh` installs or updates one
  environment (staging or production) on Ubuntu: its own service user,
  folder, settings file (640), PostgreSQL role and database (created with a
  generated password when the settings name none), nginx site with the
  security headers, and the certificate. It refuses an address or port used
  by another site and the production key on staging; checks health and rolls
  back automatically when a new version does not start. Documents and keys
  live in `/opt/juspol/<env>/storage` — **back that folder up with the
  database.** `deploy/install.sh status --env staging` shows service, log and
  health; `deploy/install.sh demo --env staging` loads the demonstration
  ministry (never on production). `deploy/test-install.sh` tests it with stubs.

### Quick start on a server (staging)

```bash
# once: the software the installer needs
sudo apt-get update && sudo apt-get install -y nginx postgresql certbot python3-certbot-nginx curl poppler-utils imagemagick
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs   # if Node.js < 20

tar -xzf juspol-edrms-0.5.1.tar.gz ./deploy/install.sh
sudo bash deploy/install.sh install --env staging --domain <name pointing at the server> \
     --port 4611 --release juspol-edrms-0.5.1.tar.gz --email <e-mail for the certificate>
sudo bash deploy/install.sh demo --env staging     # demonstration accounts; asks for their password
```

On staging the session cookie follows the connection, so sign-in also works
while the certificate cannot be obtained yet; production only signs in over
HTTPS.

Check `https://<server>/api/health`:
`{"status":"ok","version":"0.5.1","database":"reachable"}` and
`https://<server>/api/v1/health` (environment, version, assistant state).

## Demonstration data

```bash
cd backend
npm run seed:demo -- --reset   # ERASES the database in .env — never on a live system
```

Builds a realistic ministry through the application's own API: the Kabinet,
two directorates with four sub-directorates, departments and offices (16 units), 22 accounts, 66 letters with their documents (scans read by OCR),
25 matters with decisions, 29 tasks, advice, replies with seals, WijSamen
reports and an exchange with another ministry, spread over ten months. All
people and letters are invented. Every account uses the `SEED_PASSWORD`.

Since V0.5.0 the demonstration has **100 accounts** (78 more people, among them
two internal auditors and six external contractors in the unit *Externe
leveranciers*) and **12 projects** in every stage: one completed, running
projects on schedule and behind, one confidential, one on hold, and business
cases as a draft, awaiting the owner and returned. `docs/ai/PROJECTS-DEMO-QUESTIONS.md`
lists who to sign in as and which questions to ask the assistant per role.

| Account | Role |
|---|---|
| minister@juspol.test | Minister (R. Dijkstra) |
| directeur@juspol.test | Directeur Justitie (M. Sardjoe) |
| directeur2@juspol.test | Directeur Bedrijfsvoering en Politie (C. Doelwijt) |
| onderdirecteur@juspol.test | Onder-Directeur Justitiële Inrichtingen (A. Boldewijn) |
| dualrole@juspol.test | Onder-Directeur Juridische Zaken en Vreemdelingenzaken, and staff (S. Hiwat) |
| onderdirecteur2@juspol.test | Onder-Directeur Bedrijfsvoering (F. Karijopawiro) |
| onderdirecteur3@juspol.test | Onder-Directeur Politie en Openbare Orde (M. Wijngaarde) |
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
constraints) lives in the database. 30 spec files (423 tests) cover authentication,
administration, registration, dossiers, documents, delegation, workflow,
timeline, tasks, approvals, case files, letters and seals, notifications,
search and dashboards, the assistant, oversight, integrations, the session
cookie per environment, and projects with their need-to-know access. The
assistant's tests use fakes only — a scripted model and a fake Gemini server;
never a real model or a real key — and include leak tests with planted text,
the tool matrix per role, the line of command, error mapping and the audit
scenarios. The
component tests check that each screen offers the right controls to the right
person and sends what the person chose.

## Security notes

- The Task Management repository contained a committed Firebase service
  account key. It is not used here and must be **revoked in the Google Cloud
  console**; treat it as exposed.
- No secrets are stored in the database or in this repository: `.env`, the
  keys folder and the document folders are excluded. The Gemini key lives only
  in the server's settings file; staging and production use different keys,
  and a staging server refuses to start with the production key or database
  (`PRODUCTION_FINGERPRINTS`).
- System administration never grants access to record content; the auditor
  reads the log, not the records.

## Repository layout

```
backend/src/records, documents, workflow, delegation, timeline   Delivery 1 core
backend/src/tasks, approvals, casefiles, letters, deadlines       Phase 3 work
backend/src/ai                     the assistant: agent/ (panel, tools, providers, loop), engine/ (built-in), llm.ts
backend/src/oversight, integrations, dashboard, search, security  oversight and links
backend/src/migrations             schema history, the only way the schema changes
backend/src/seed                   pilot accounts and demonstration data
backend/test                       integration suite
frontend/src/pages, shell, ui      the interface; *.test.tsx component tests
deploy/                            install, pack, nginx, systemd, backup and restore
docs/                              delivery notes and tester guides; docs/ai the assistant's documents
```
