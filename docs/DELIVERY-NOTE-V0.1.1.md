# JusPol EDRMS — Delivery Note V0.1.1

**Slice:** Identity foundation — individual accounts, functional roles, authenticated sessions
**Baseline:** FS-01 to FS-08 (FS-06 adopted per JUSPOL-ADD-C-01); TS-01 to TS-12; TS-ADDENDUM-01; JUSPOL-ADD-PKG-01
**Prepared under:** Development Behavior & Process Manual v1.1 §4.2 (verification status), §5.1 (logical slices), §5.2 (versioning)
**Date:** September 2026

---

## 1. Scope of this version

Delivered:

- The FS-06 identity model as a relational schema: Person, Account, Functional Role, Role Assignment, Organisational Unit — five separate objects, so a person, their role and their login remain distinct concepts
- Authentication with server-side sessions stored in PostgreSQL
- Role assignment per account, including accounts holding more than one role
- One protected screen showing the authenticated identity and its active roles
- Nine seeded pilot accounts covering all four FS-01 §3 business roles, the Pilot System Administrator, a dual-role account and a disabled account
- An unauthenticated health endpoint

Explicitly **not** in this version, and not silently started:

- Records, dossiers, registration, correspondence — no business objects exist yet
- Permission evaluation per FR-SEC-003. Roles are stored and displayed; nothing is yet protected by them beyond the authentication boundary
- Sensitivity / need-to-know model (DEC-02 dependent)
- Delegation (FS02-AC-004)
- Audit event storage. See §4, item 1
- Search, Task Management integration, AI assistance

## 2. Requirements addressed

| Requirement | How this version satisfies it |
|---|---|
| FR-SEC-001 | Each user authenticates through an individual account. No shared account exists in the schema or the seed |
| FR-SEC-002 | One or more functional roles can be assigned per account. Verified against a dual-role account |
| FR-SEC-004 | A failed permission condition denies the action. In this version the condition is a valid session; broader evaluation follows |
| FR-SEC-011 | Disabling an account prevents login and invalidates an existing session on its next request. Role revocation sets `revoked_at` rather than deleting the row, so prior evidence survives |
| FR-SEC-008/009/010 | Each account exposes only its own configured roles. The administrator account carries no business role |

FR-SEC-003, 005, 006, 007, 012 and 013 are **not** claimed by this version. The security-before-display principle is honoured at the authentication boundary only, because there is as yet nothing to display.

## 3. Verification status

Executed in a real environment — PostgreSQL 16, Node 20, Chromium — not reasoned about:

**Compiled / built**
- Backend: `tsc --noEmit` clean, zero errors
- Frontend: production build clean, 30 modules transformed

**Ran against a live database**
- Migration `InitIdentity1758100000000` applied clean; six tables created
- Seed created all nine accounts; re-running it created nothing further (idempotent)
- `/api/health` returned `{"status":"ok","version":"0.1.1","database":"reachable"}`

**Behaviour checks executed by hand — 20 of 20 passed**

| # | Check | Result |
|---|---|---|
| 1 | Protected endpoint without a session | 401, no data |
| 2 | Valid sign-in returns the correct person, unit and role | pass |
| 3 | Session cookie carries HttpOnly | pass |
| 4 | `/me` with a valid session | pass |
| 5 | Wrong password | 401, `Invalid email or password.` |
| 6 | Unknown email | 401, identical message |
| 7 | Disabled account with the correct password | 401, identical message |
| 8 | Dual-role account shows exactly two roles | pass |
| 9 | Undeclared field `isAdmin: true` in the request body | 400, rejected |
| 10 | Old cookie replayed after sign-out | 401 |

Checks 5, 6 and 7 returning a byte-identical message is the point of them: a distinguishable response would let an outsider discover which ministry addresses are real accounts. This is the same property the TS-06 identity-enumeration cases require of search.

**Driven through a real browser**
- Sign-in page renders; failed sign-in shows the error; successful sign-in reaches the identity screen with correct values
- Session identifier is regenerated on sign-in, so a value observed before authentication cannot be replayed after it

## 4. Not verified, and why

1. **No audit event storage.** FS02-AC-007 requires role assignment changes to be auditable, and FR-AUD requirements require attributable server-timed events. Neither is possible until an append-only event table exists. `last_login_at` is recorded, but that is a field, not an audit trail. **Recommended as V0.1.2**, before any behaviour worth auditing is built on top of this layer.
2. **No automated test suite.** The twenty checks above were executed by hand and are reproducible from this note, but nothing yet re-runs them on change. This weakens the regression discipline of Manual §3 from V0.1.3 onward.
3. **No rate limiting or lockout on sign-in.** Nothing in the frozen baseline mandates it for the PoC, and it is Class 3 hardening rather than a blocker, but a pilot on a reachable URL should have it before real users are added.
4. **HTTPS not exercised.** With `NODE_ENV=production` the session cookie becomes Secure, which requires TLS. That path was not testable in the build environment, so confirm sign-in works on the deployed URL before releasing it to testers.
5. **Password policy not enforced.** Seeded accounts share one password by design. No complexity or rotation rule exists, and none is specified in the baseline.

## 5. Deviation from the agreed slice size

The agreed rule is 500–700 lines per version, up to 1,000 to finish a function coherently. This slice is approximately **1,050 lines** — backend around 660, frontend around 390, excluding configuration files.

Reason: authentication is not testable by a non-technical tester without a sign-in screen. Splitting the frontend into a separate version would have delivered a V0.1.1 that only an engineer with an API client could exercise, which defeats the purpose of the tester programme.

Recorded here as an intentional deviation under Manual §11.1, not an accident. If the Product Authority prefers the rule held strictly, the frontend can be reissued as V0.1.2 and this version reduced to the API.

## 6. Delivery contents

| Item | Path |
|---|---|
| Backend source | `backend/` |
| Frontend source | `frontend/` |
| Deployment instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.1.md` |
| Tester guide (4 tabs, expected outcomes on a hidden tab) | `docs/JusPol-EDRMS-V0.1.1-Tester-Guide.xlsx` |

`node_modules`, build output and `.env` are excluded. `.env.example` is included.

## 7. Suggested commit message

```
V0.1.1 — identity foundation: accounts, roles, sessions

FS-06 identity model as five tables (person, account, functional_role,
role_assignment, organisational_unit), keeping person, role and account as
separate concepts so historical authorship survives account changes.

Authentication with server-side sessions in PostgreSQL, scrypt password
hashing, session regeneration on sign-in, and a guard that re-checks account
state on every request so disabling an account takes effect immediately.
Failed sign-in returns one identical message for a wrong password, an unknown
email and a disabled account, to prevent account enumeration.

Sign-in and identity screens in React. Nine seeded pilot accounts covering the
FS-01 §3 roles plus a dual-role and a disabled account.

Addresses FR-SEC-001, 002, 004, 008, 009, 010, 011.
Not addressed: FR-SEC-003, 005, 006, 007, 012, 013 — no records exist yet.
No audit event storage; recommended as V0.1.2.
Migrations only; TypeORM synchronize is never enabled.
```

## 8. Next step

V0.1.2 — append-only audit event storage with server-authoritative time, plus role assignment and revocation through the administrator account so FS02-AC-005 and FS02-AC-007 become testable. Estimated 550–650 lines.
