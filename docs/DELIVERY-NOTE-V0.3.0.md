# Delivery note — JusPol EDRMS V0.3.0 (Phase 3)

Date: {{DATE}}

## What this delivery is

Phase 3 merges the two Workflow panels — EDRMS (Delivery 1, V0.1.18) and Task
Management — into one system, and adds a free assistant (AI) that runs on the
ministry's own server. The EDRMS is the foundation: its registry rules, audit
chain, document integrity and permissions are unchanged and still tested.
Task Management is rebuilt inside it, so a task always belongs to a letter or a
matter, follows the same permissions and appears in the same audit log.

The feature document `JusPol-EDRMS-V0.3.0-Features.pdf` lists every feature
with a screenshot of it running on the demonstration data.

## Evidence

| Check | Result |
|---|---|
| Backend integration suite (real PostgreSQL 16) | {{BACKEND_TESTS}} |
| Frontend component tests | {{FRONTEND_TESTS}} |
| Production build (backend `tsc`, frontend `vite build`) | passes |
| HTTPS behind nginx 1.24, production mode | secure HttpOnly SameSite cookie; HSTS and CSP on every response; service worker registered; PDF viewer works under the CSP |
| Backup and restore (`deploy/test-backup-restore.sh` on the demonstration database) | rows, all 64 files (SHA-256), seal key and audit hash chain identical on the restored copy; a damaged backup is refused |
| Integrity check on the demonstration data | audit chain intact, all files unchanged, all seals valid |
| Screenshots | every feature, as the role that uses it, in Dutch, English, dark, high contrast, large text and on a phone |

## Decisions taken in this phase

- **Merge, with EDRMS as the foundation.** One login, one permission model, one audit log.
- **The assistant is free and local by default.** The built-in engine needs no
  internet and no subscription. An open-source model (Ollama) on a ministry
  server can be added for fluent writing and translation. An external service
  is possible but is never sent confidential or secret records. Every
  suggestion waits for a person's confirmation and is logged.
- **Seals are a system seal (Ed25519), not a qualified electronic signature.**
  They prove a document came from this system unchanged; anyone can check one
  with the QR code. A legally qualified signature needs a certificate authority
  and a legal basis, which is a decision for the ministry.
- **Mobile is an installable web app (PWA)**, not separate store apps.
- **Outside systems are built as tested connection points**: SMTP e-mail, an
  HTTP SMS gateway (e.g. Telesur or Digicel business API) or Twilio, web push,
  the WijSamen app, the ministry mail server, the National Archive (archive
  package) and other ministries (signed exchange packages). Each is tested
  against a local stand-in; connecting the real one is configuration.

## Open decisions carried forward

The open decisions from Delivery 1 stay parameterised, with neutral defaults:
registration and dossier numbering (DEC-01, DEC-11), mandatory metadata
(DEC-08), due-date reasons (DEC-12), the delegation matrix (DEC-13), dossier
closure authority, whether approval authority may be delegated. New in this
phase, also configuration rather than policy: retention periods per category in
the file plan, the approval routes, who sees confidential and secret records,
and which assistant features are switched on.

## Known limits

- Translation needs a language model; the built-in engine does not translate.
- Islamic and Hindu holidays move each year; the fixed Surinamese holidays load
  with one button, the moving ones are entered when the government announces them.
- Push notifications need HTTPS and outbound access from the server to the
  browsers' push services.
- In the demonstration no mail server or SMS gateway is connected: e-mail and
  text messages are recorded in the outbox and marked "not sent". Connecting
  them is configuration on the server.
- In the demonstration two-step verification is not required, so every account
  can sign in. For live use, switch it on for the Minister, the directors and
  the administrators (Beheer → Instellingen).
- The Task Management repository contained a committed Firebase service-account
  key. It is not used in Phase 3. **Revoke it in the Google Cloud console.**

## What is in the package

`backend/` (API, migrations, seed and demonstration data, tests), `frontend/`
(interface, component tests), `deploy/` (nginx, systemd, backup and restore),
`docs/` (this note, earlier delivery notes and tester guides), `screenshots/`.
Not included: `.env` files, keys, stored documents, `node_modules`, build output.
