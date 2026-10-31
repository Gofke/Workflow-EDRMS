# Changelog

## Unreleased

- `deploy/install.sh` accepts Google's new API key format (`AQ.…`), which AI Studio issues since 2026; the assistant already sends the key in the `x-goog-api-key` header that these keys need
- `install.sh demo` checks the application's password rule (12 characters, three kinds of character) before loading; it allowed 10, so loading stopped at the first account
- Installer test: 28 checks

## V0.4.1 — Installer ready for a real server

- `deploy/install.sh`: documents and keys are stored in `/opt/juspol/<env>/storage` (the release folder is read-only for the service, so V0.4.0 could not create its sealing key there and did not start)
- Release files readable by the service and by nginx (V0.4.0 left the release folder readable by root only)
- `deploy/pack.sh` packs `backend/assets` (the fonts of every PDF: receipts, labels, reports, seals); V0.4.0 packed none, so a server could not make PDFs. The installer refuses a release without them
- The PostgreSQL role and database `juspol_<env>` are created with a generated password when the settings name none; the template's example values (`change_me…`) no longer pass as filled in
- Fresh `SESSION_SECRET` and `MFA_ENCRYPTION_KEY` for every environment; `PUBLIC_BASE_URL` follows the address that really works
- The server is checked first (Node.js 20+, npm, nginx, PostgreSQL client, certbot) with the command to install what is missing
- nginx site with the security headers (HSTS, CSP, nosniff), caching rules for the service worker and assets, as in `deploy/nginx.conf.example`
- New `install.sh demo --env staging [--reset]`: loads the demonstration ministry; the accounts' password is asked hidden and never stored; refused on production
- Session cookie on staging follows the connection (Secure over HTTPS), so staging works while its certificate cannot be obtained; production unchanged (HTTPS only)
- Tests: backend 388 (session cookie per environment 9), frontend 40, installer 25 with stubs, and a real run on Ubuntu 24.04 (PostgreSQL 16, nginx 1.24, Node.js 22): install, update with database copy, demonstration data, sign-in, assistant and a PDF report through nginx

## V0.4.0 — Assistant panel on Gemini, line of command

- "Vraag de assistent": a chat panel like ChatGPT on every page, docked on the right (full screen on a phone): model badge, examples per role, safe Markdown answers with record cards, Stop, new chat, questions left this hour, privacy notice for the free tier
- Google Gemini (free tier) behind a provider adapter (Gemini, OpenAI-compatible, Ollama, Anthropic), switched by settings or environment; fallback model `gemini-flash-lite-latest`, then the built-in offline assistant
- Read-only tools filtered by role and line of command: my work, find, list, count (per unit, person, status, month), deadline risk, organisation, summary and draft reply (made on the server, shown as cards), retention (records manager), audit figures (auditor), system status (system administrator)
- Line of command: Minister → directorate → sub-directorate → department → employee; stand-ins included; enforced in every query, never in the prompt
- Free tier gets metadata only: no subjects, document text or confidential records; typed phone numbers, e-mail addresses and ID numbers removed
- `POST /api/v1/ai/query`, `GET /api/v1/ai/status`, `GET /api/v1/ai/config`, `GET /api/v1/health` in the guide's contract and error codes
- Limits: 30 questions per person per hour, 60 requests per address per minute, 6 rounds, 30 s per call, 80 s per question
- Audit events `AI_QUESTION_ANSWERED` / `AI_QUESTION_FAILED` without question text
- New unit kind Onderdirectoraat; demonstration ministry with two directorates and four sub-directorates; organisation shown as a tree
- Beheer → Assistent: Gemini, fallback models, data policy, scope, questions per hour, offline fallback; values fixed on the server shown as such
- `deploy/install.sh` (staging/production, rollback, refuses another site's address and the production key on staging), `deploy/pack.sh`, stubbed installer test
- Start-up guard: a staging server refuses the production key or database
- Documents: business document, design, audit document with AU-01…AU-35, evaluation set (40 NL + 40 EN), tester sheet
- Independent review: 20 findings fixed — stand-ins keep their own line, summaries and drafts respect the line, confidential records never in counts or lists sent to the model (a note card tells the person), look-alike numbers redacted, free-tier rule for every external provider and parsed local addresses, hourly quota safe under parallel questions, installer keeps secrets off the command line and follows a new port, database copy before every update
- Tests: backend 379 (assistant 84), frontend 40, installer 12
- Model to record at release: `gemini-flash-latest` (alias) — write the `modelVersion` returned on staging here; evaluation score: pending (run with the ministry's key on staging)

## V0.3.0 — Phase 3

The Workflow EDRMS and Workflow Task Management panels merged into one system,
with a free built-in assistant. See `docs/DELIVERY-NOTE-V0.3.0.md` and the
feature document for the full list.

- One interface for post, matters, tasks, approvals, archive and oversight (Dutch and English; light, dark, high contrast; installable on phones)
- Tasks from Task Management rebuilt inside the EDRMS: board, calendar, checklists, subtasks, comments with mentions, attachments, templates, recurrence, reminders and escalation
- Free assistant on the ministry's own server: chatbot, plain-language questions, field proposals from scans, deadlines, near-duplicates, routing, summaries, draft replies, deadline risk, meeting notes into tasks; optional local open-source model (Ollama)
- Approval routes with several steps, advice requests, out-of-office stand-ins
- Letters and replies from templates, versions, Ed25519 seal with QR and public check page; receipts, labels and public tracking for senders
- Search in letters, matters, tasks and scanned text; saved searches
- Management overview, departments, workload and trends; sealed PDF and Excel reports
- File plan, retention decisions, legal hold, archive package for the National Archive
- Audit viewer and exports, nightly integrity check with sealed statement
- WijSamen reports, e-mail intake, signed exchange with other ministries
- Notifications in the system, by e-mail, SMS and push; daily digest and weekly report
- Deployment: nginx with TLS and security headers, systemd unit, tested backup and restore

## V0.0.2

Updated application baseline to JusPol EDRMS V0.1.18.

### Included
- JusPol EDRMS V0.1.18 backend
- JusPol EDRMS V0.1.18 frontend
- Database migrations and tests
- Updated project documentation and tester materials

No production credentials, runtime data, dependencies or build artifacts are included.

## V0.0.1

Initial GitHub repository release.

Application baseline: JusPol EDRMS V0.1.17

### Included
- Backend API and database migrations
- Frontend application
- Automated tests
- Project documentation and tester guides
- Environment configuration examples

Production credentials, runtime data, dependencies and build artifacts are intentionally excluded.
