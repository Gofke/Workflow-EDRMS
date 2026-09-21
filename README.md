# JusPol EDRMS — V0.1.17

Electronic Document and Records Management System for the Ministry of Justice and
Police, Suriname. Delivery 1 — Head Office Proof of Concept.

Delivery 1 to date:

- **V0.1.1** — identity foundation: individual accounts, functional roles, sessions
- **V0.1.2** — append-only audit events; role and account administration
- **V0.1.3** — correspondence items: draft capture and official registration
- **V0.1.4** — automated integration test suite
- **V0.1.5** — dossiers and record-to-dossier linking
- **V0.1.6** — responsibility and official due dates
- **V0.1.7** — document capture, integrity and retrieval — **closes Gate 2**
- **V0.1.8** — delegation and acting on behalf
- **V0.1.9** — submit, return for correction, approve
- **V0.1.10** — finalisation and reopening — **closes Gate 3**
- **V0.1.11** — consolidation: audit hardening, component tests, cumulative re-audit
- **V0.1.12** — dossier timeline (BR-009)
- **V0.1.13** — dossier closure and reopening (FR-DOS-006 to 008)
- **V0.1.14** — timeline paging and CSV export
- **V0.1.15** — possible-duplicate warning at registration (FR-COR-016)
- **V0.1.16** — OCR text as retrieval assistance, off by default (FR-COR-015)
- **V0.1.17** — PDF text-layer reading, under the same switch

Record-level permission evaluation (Gate 4, waits on DEC-02) and search are not built yet.

| | |
|---|---|
| Backend | NestJS 10, TypeScript, PostgreSQL 16, TypeORM (migrations only) |
| Frontend | React 18, TypeScript, Vite |
| Sessions | Server-side, stored in PostgreSQL, HttpOnly cookie |
| Passwords | Node crypto scrypt (no native build step required) |

## Deploying this version

Requires Node.js 20 or later and PostgreSQL 14 or later.

### 1. Database

```sql
CREATE USER juspol WITH PASSWORD '<choose a strong password>';
CREATE DATABASE juspol_edrms OWNER juspol;
\c juspol_edrms
GRANT ALL ON SCHEMA public TO juspol;
```

### 2. Backend

```bash
cd backend
cp .env.example .env          # then edit .env — see the note below
npm install
npm run migration:run         # creates the six tables
npm run seed                  # creates the nine pilot accounts
npm run build && npm start    # or: npm run start:dev
```

In `.env` you must set, at minimum:

- `DB_PASSWORD` — the database password chosen above
- `SESSION_SECRET` — a long random string, unique per environment
- `SEED_PASSWORD` — the shared password for the seeded test accounts
- `CORS_ORIGIN` — the URL the testers will open in their browser
- `REGISTRATION_IDENTITY_PATTERN` and the marker values — **optional**. These
  exist because DEC-01 (the registration numbering scheme) is an open decision.
  The default `{DIRECTION}-{YEAR}-{SEQ}` is a neutral placeholder, not a proposed
  scheme. Set them once DEC-01 is decided; changing the pattern does not alter
  references already assigned, which is the intended behaviour.
- `REGISTRATION_MANDATORY_FIELDS` — **optional**, default `subject`. Exists
  because DEC-08 (the minimum mandatory metadata set) is open.
- `DOSSIER_IDENTITY_PATTERN` and `DOSSIER_SEQUENCE_PADDING` — **optional**.
  Exist because DEC-11 (the dossier identity scheme) is open. The default
  `DOS-{YEAR}-{SEQ}` is a placeholder, not a proposed scheme.
- `DOCUMENT_STORAGE_PATH` — where captured document bytes are stored, content
  addressed by SHA-256. **This directory must be backed up with the database.**
  The database holds the integrity reference; the directory holds the evidence.
- `DOCUMENT_MAX_BYTES` and `DOCUMENT_ALLOWED_TYPES` — **optional**. Operational
  settings, not baseline decisions.
- `DELEGATION_GRANTING_ROLES`, `DELEGATABLE_ACTIONS` and
  `DELEGATION_MAX_DURATION_DAYS` — **optional**. These exist because DEC-13, the
  delegation capability matrix, is open. The defaults are deliberately narrow: a
  delegation granted in a pilot cannot be un-granted from history later.
- `WORKFLOW_APPROVAL_DELEGATION` — **optional**, default off. Whether approval
  authority may be delegated at all. FR-WFL-006 permits an on-behalf approval
  only where acting on behalf is explicitly allowed, so this defaults to `false`.
- `OCR_ENABLED` — **optional**, default `false`. Whether text is read from
  captured images. FR-COR-015 is conditional ("where OCR is enabled") and an OCR
  engine is an operational decision. When `true`, `OCR_COMMAND` (default
  `tesseract`) must be installed on the server. `OCR_LANGUAGES` (default `eng`),
  `OCR_TIMEOUT_MS`, `OCR_MEDIA_TYPES` and `OCR_MAX_CHARACTERS` are also optional.
  Read text is assistance for finding a document and never replaces it.
- `PDF_TEXT_COMMAND` — **optional**, default `pdftotext` (poppler-utils), used
  for PDFs when `OCR_ENABLED=true`. `PDF_TEXT_MEDIA_TYPES` is also optional. A
  PDF that is only a scanned page has no text layer and reads as empty; reading
  the page image inside a PDF is not built.
- `DOSSIER_CLOSURE_ROLES` — **optional**, default
  `MINISTER,DIRECTEUR,ONDER_DIRECTEUR`. Who may close and reopen a dossier.
  Exists because close/reopen authority is an open decision (FS-01 §14 item 7;
  FS-03 lists it as Delivery 1 configuration). Not delegatable.
- `DUE_DATE_REASON_REQUIRED_ON` — **optional**, one of `always`, `change`
  (default) or `never`. Exists because DEC-12 (which due-date changes require a
  reason) is open. `change` asks for a reason when an existing official deadline
  moves or is removed, but not when one is first set.
- `NODE_ENV=production` on the deployed environment, which switches the session
  cookie to Secure. The site must then be served over HTTPS or sign-in will fail.

### 3. Frontend

```bash
cd frontend
npm install
npm run build                 # output in frontend/dist
```

Serve `frontend/dist` as static files and route `/api/*` to the backend on port
3000 — any reverse proxy will do. In development, `npm run dev` proxies `/api`
automatically, so no extra configuration is needed.

### 4. Confirm it is up

Open `/api/health`. The expected response is:

```json
{"status":"ok","version":"0.1.1","database":"reachable"}
```

## Running the tests

The suite runs against a **real PostgreSQL database**, because most of what it
protects — the append-only audit rules, the registry identity trigger, the unique
index, the check constraints — is enforced below the application. A mocked
repository would pass every one of those tests while proving nothing.

```bash
createdb juspol_edrms_test          # or: CREATE DATABASE juspol_edrms_test OWNER juspol;
cd backend
cp .env.test.example .env.test      # then edit DB_PASSWORD
npm test
```

The database named in `.env.test` **must** be a dedicated test database: the
suite truncates tables between spec files. It refuses to start if the name does
not contain `test`.

137 tests across ten spec files: authentication, administration, registration,
dossiers, responsibility, captured documents, delegation, review workflow,
timeline, and database-level integrity. They run in band, in about 20 seconds.

## Running the component tests

Separate from the integration suite, and much faster — no database:

```bash
cd frontend
npm test
```

20 component tests covering what the screen offers, per state and per person.
They exist because five consecutive slices shipped an interface defect the
integration suite could not see. Each one pins a defect that actually occurred.

## Repository layout

```
backend/src/identity/      FS-06 identity objects (person, account, role, unit)
backend/src/records/       correspondence items, registration, dossiers,
                           linking, responsibility, due dates
backend/src/documents/      document capture, content-addressed storage, integrity
backend/src/delegation/     delegated authority, acting on behalf
backend/src/workflow/       submit, return for correction, approve, finalise
backend/src/timeline/      the derived chronological account of a matter
backend/src/audit/         append-only event history
backend/src/admin/         account and role administration
backend/src/auth/          authentication, sessions, password hashing, guard
backend/src/migrations/    schema history — the only way the schema changes
backend/src/seed/          pilot test accounts
frontend/src/pages/        sign-in screen and identity screen
backend/test/              integration test suite
docs/                      delivery notes and tester guides
```

## Test accounts

All nine seeded accounts share the password set in `SEED_PASSWORD`. They are
invented people on the non-routable `.test` domain and must never be used with
real ministry information. The full list is on the Accounts tab of
`docs/JusPol-EDRMS-V0.1.1-Tester-Guide.xlsx`.
