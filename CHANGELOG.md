# Changelog

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
