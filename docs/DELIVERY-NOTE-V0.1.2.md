# JusPol EDRMS — Delivery Note V0.1.2

**Slice:** Append-only audit event storage, plus role and account administration
**Builds on:** V0.1.1 (identity foundation). That version's behaviour is now protected baseline.
**Baseline:** FS-01 to FS-08 (FS-06 adopted per JUSPOL-ADD-C-01); TS-01 to TS-12; TS-ADDENDUM-01; JUSPOL-ADD-PKG-01
**Prepared under:** Development Behavior & Process Manual v1.1 §3 (protected baseline), §4.2 (verification status), §5.1 (logical slices)
**Date:** September 2026

---

## 1. Scope of this version

Delivered:

- `audit_event` table holding attributable, server-timed events, with UPDATE and DELETE blocked **in the database**
- Seven event types recorded: sign-in succeeded, sign-in failed, sign-out, role assigned, role revoked, account disabled, account enabled
- Role assignment and revocation by the Pilot System Administrator
- Account enable and disable by the Pilot System Administrator
- A roles guard, so a route can require a functional role in addition to a session
- Administration screen: account list, role chips with revoke, role assignment, enable/disable, and a readable event history
- Every state-changing control asks for confirmation before it acts

Explicitly **not** in this version:

- Records, dossiers, correspondence — still no business objects
- Full permission evaluation per FR-SEC-003. The role component now exists; scope, record relationship, sensitivity, delegation and workflow state do not
- Delegation (FS02-AC-004)
- Sensitivity model (DEC-02 dependent)
- Account creation and password reset. Accounts still come from the seed
- Audit filtering, paging or export. The list returns the most recent events only

## 2. Requirements addressed

| Requirement | How this version satisfies it |
|---|---|
| FS02-AC-007 | Role assignment, revocation and account state changes each write an audit event naming the actual administrator who acted |
| FR-GEN-007 | No silent overwrite. Revocation marks `revoked_at`; the prior assignment event remains. Database rules make UPDATE and DELETE on `audit_event` no-ops |
| FR-AUD (attribution) | Every event carries the authenticated account id plus the person's name as it stood at the time. The actor is taken from the session, never from the request body |
| FR-AUD (server time) | `occurred_at` defaults to the database's `now()`. No client value is accepted |
| FR-SEC-011 | Disabling an account ends its session on the next request, and revoking a role removes the authority without deleting history |
| FR-SEC-008/009/010 | Administration and audit routes require SYS_ADMIN. Support staff, Onder-Directeur, Directeur and Minister are all refused, so seniority is not administrative authority |

Not claimed: FR-SEC-003, 005, 006 (beyond these routes), 007, 012, 013, and FR-AUD requirements concerning record lifecycle reconstruction — there are no records to reconstruct.

## 3. Verification status

Executed against PostgreSQL 16, Node 20 and Chromium. Not reasoned about.

**Compiled / built**
- Backend `tsc --noEmit`: clean
- Frontend production build: clean, 32 modules

**Migration**
- `AuditAndRoleAdmin1758200000000` applied clean on top of the V0.1.1 schema
- Confirmed both rules exist: `audit_event_no_update`, `audit_event_no_delete`

**Authorisation checks — all passed**

| Check | Result |
|---|---|
| Administrator lists accounts | 200, nine accounts |
| Directeur calls the same endpoint | 403 |
| No session at all | 401 |
| Directeur tries to assign themselves SYS_ADMIN | 403 |
| Administrator assigns a role | 200; target's own session then shows both roles |
| Administrator revokes it | 200; target's session shows one role again |
| Administrator disables an account mid-session | that session's next request returns 401 |
| Non-administrator reads the audit trail | refused |

**Tamper check — the important one**

Using the application's own database credentials, direct SQL was attempted against the history:

```
UPDATE audit_event SET summary='tampered', occurred_at='2020-01-01' ...   →  UPDATE 0
DELETE FROM audit_event;                                                  →  DELETE 0
```

Row count unchanged at 6; zero rows contained the tampered value. Both statements reported success and changed nothing. **Testers and TS-08 cases must therefore verify the row afterwards rather than trust the response.** That is a property of the rule mechanism, not a defect, and it is recorded here so nobody mistakes a silent success for a successful edit.

**Audit content check**

Three refusals — wrong password, unknown email, disabled account — returned the byte-identical message `Invalid email or password.` while the trail recorded `incorrect password`, `no such account` and `account disabled` respectively. That split is deliberate: the reason belongs to authorised reviewers, not to the caller.

**Driven through a real browser**
- Administrator sees the administration section; a role assigned through the UI produced the confirmation message and a matching top line in the event history within the same second
- A support-staff account signed in simultaneously saw no administration section and no event history at all
- Sign-out, disable-mid-session, re-enable and sign-in-again all behaved as described above

## 4. Not verified, and open items

1. **An administrator can revoke their own SYS_ADMIN role and lock everyone out of administration.** There is no last-administrator guard. Nothing in the frozen baseline requires one, and the seed can restore access, but on a live pilot this is a real foot-gun. **Recommended for V0.1.3** — a refusal when the change would leave zero enabled administrators, plus its own audit event.
2. **Still no automated test suite.** Both versions' checks were executed by hand. From V0.1.3 the regression surface is wide enough that this becomes the highest-value next investment after the records model.
3. **Audit write failure does not fail the action.** For sign-in and role changes the event write is logged loudly if it fails, but the action proceeds. Once business records exist, an action whose audit write fails must fail with it. Recorded in the service comments as well as here.
4. **No rate limiting or lockout on sign-in.** Unchanged from V0.1.1. Failed attempts are now at least recorded, which makes the gap visible rather than invisible.
5. **Audit list has no paging.** It returns up to 500 events, newest first, capped. Fine for a pilot; not fine at ministry scale.
6. **HTTPS still not exercised.** Confirm sign-in works on the deployed URL before releasing it to testers, because `NODE_ENV=production` makes the session cookie Secure.

## 5. Slice size

Approximately **610 lines** of new and changed code — backend around 400, frontend around 210, excluding configuration. Within the agreed 500–700 band, without an exception.

## 6. Delivery contents

| Item | Path |
|---|---|
| Backend source | `backend/` |
| Frontend source | `frontend/` |
| Deployment instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.2.md` |
| V0.1.1 note (retained) | `docs/DELIVERY-NOTE-V0.1.1.md` |
| Tester guide, 20 steps, expected outcomes on a hidden tab | `docs/JusPol-EDRMS-V0.1.2-Tester-Guide.xlsx` |

`node_modules`, build output and `.env` are excluded. Deploy by running `npm run migration:run` again — the V0.1.1 migration is already recorded and will not re-run.

## 7. Suggested commit message

```
V0.1.2 — append-only audit events, role and account administration

Adds audit_event: attributable, server-timed, append-only. UPDATE and DELETE
are blocked by database rules rather than by convention, so history cannot be
rewritten even from a direct SQL session using the application's own
credentials. No foreign key to account, so an event survives as evidence if the
account it names is later removed.

Records sign-in success and failure, sign-out, role assignment and revocation,
and account enable/disable. The failure event records why the attempt was
refused while the response to the caller stays identical for all three causes,
so the reason reaches reviewers without enabling account enumeration.

Adds a roles guard and administration routes requiring SYS_ADMIN, plus an
administration screen with confirmation on every state-changing control.
Revocation marks revoked_at rather than deleting the assignment.

Addresses FS02-AC-007, FR-GEN-007, FR-SEC-011, FR-SEC-008/009/010 and the
FR-AUD attribution and server-time requirements.
Open: no last-administrator guard — see delivery note §4 item 1.
```

## 8. Next step

V0.1.3 — the records model: Correspondence Item and Dossier per FS-06, registration with an official registration identity that cannot be silently modified, and dossier linking. This is the first version where FR-SEC-003 permission evaluation and the security-before-display rule become genuinely testable. Estimated 650–700 lines, and likely the point at which an automated test suite stops being optional.
