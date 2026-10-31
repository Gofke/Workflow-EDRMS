# Changelog

## V0.5.0 — Projects, from business case to handover

- **Projecten**: each project has an owner (opdrachtgever), a project manager (projectleider), stakeholders and team members; number `PRJ-yyyy-nnn`; classification internal or confidential
- Business case as the first phase: problem, solution, benefits, costs, risks and budget. The project manager submits it once its tickets are done; the owner approves it (phase 1 closes, the project starts, phase 2 opens) or returns it with a reason
- Phases (3–8, standard four: business case, documentation and design, execution, closure and handover) with dates; the project manager closes a phase when its tickets are done; the owner signs off the last phase, which completes the project; hold, resume and cancel by the owner with a reason
- Tickets are tasks in a phase, with an assignee, a start date and a due date, and the same comments, checklists, notifications and audit as every task
- Planning tab with a Gantt chart of phases and tickets (late in red, filter "only what is late"); portfolio time line of all projects; progress per phase and per project
- Need-to-know access, decided on the server: owner and project manager see everything; a stakeholder the business case, phases and team but no tickets; the line of command (Minister; directors and heads over the project's unit) a summary without the business case text or tickets; a team member, such as an external contractor, only their own tickets; a confidential project only the people on it. A ticket in a project is never visible through the line of command
- Mijn werk shows business cases and sign-offs waiting for the owner; notifications for a project role, a submitted business case, the owner's decision and each new phase
- Audit events for every step (`PROJECT_CREATED`, `BUSINESS_CASE_SUBMITTED/APPROVED/RETURNED`, `MILESTONE_CLOSED`, `PROJECT_STATUS_CHANGED`, `PROJECT_COMPLETED` and others); projects cannot be deleted
- Assistant: new tools `projects` and `project_detail` with the same need-to-know as the screens; the model receives numbers, statuses, phases, dates and counts only — never project names, ticket titles or business case text under the metadata policy, and nothing from a confidential project (the person gets a card and a note); a project question in the examples of each business role
- Independent review before release, in two rounds (15 findings, then 5 found while verifying the fixes), all fixed. Project data now stays need-to-know through every other route:
  - an overdue ticket escalates to the project manager and then the owner, never up the line, and the audit log names only its number;
  - a stand-in gets no copy of project or ticket notifications, and a notice about a ticket reaches only people who may open it (not a previous project manager, not someone mentioned from outside the project);
  - a ticket does not repeat, so no copy is ever made outside the project;
  - leaving a project ends following its tickets;
  - a subtask of a ticket stays in the project: only for people on it, never linked to a matter or letter (also a database constraint), and it is not on any matter's timeline;
  - the assistant's ordinary task tools treat a confidential project's tickets as confidential;
  - phase names are not sent to the model under the metadata policy;
  - the project history names tickets by number only, and the line of command gets no description or hold reason;
  - ministry-wide counts (overview, departments, workload, weekly report) leave confidential tickets out.
- The project rules are stricter:
  - the project manager writes the business case and every save is audited;
  - owner and project manager must be two different people, and whoever wrote or submitted a business case never decides on it, even after the roles are swapped;
  - owner and project manager cannot be changed while a business case awaits the decision;
  - a replaced project manager loses the tickets, which pass to the new one;
  - only the owner or the project manager reassigns a ticket, to a ministry account, and the new holder joins the team with an audit entry;
  - only the owner changes someone's role;
  - a removed person who gets a ticket comes back as a team member only;
  - no new tickets in the business case phase after submission, and no reopened tickets in a closed phase;
  - gates count subtasks and are checked under a lock, which also makes a ticket that waited for the lock see a phase closed meanwhile;
  - no new phase once the closure has started;
  - resume needs a reason;
  - cancelling a project cancels its open tickets.
- Demonstration: 100 accounts (78 more people, among them two internal auditors and six external contractors) and 12 projects in every stage; `docs/ai/PROJECTS-DEMO-QUESTIONS.md` with the questions to ask per role and what must happen
- `deploy/install.sh` accepts Google's new API key format (`AQ.…`), which AI Studio issues since 2026; the assistant already sends the key in the `x-goog-api-key` header that these keys need
- `install.sh demo` checks the application's password rule (12 characters, three kinds of character) before loading; it allowed 10, so loading stopped at the first account
- Installer test: 28 checks
- Tests: backend 423 (projects 13, assistant on projects 5, need-to-know through every route 17), frontend 40, installer 28

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
