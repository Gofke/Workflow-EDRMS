# JusPol EDRMS — Delivery Note V0.1.4

**Slice:** Automated integration test suite
**Product behaviour added:** none. This version changes no feature and adds no requirement coverage.
**Builds on:** V0.1.1 to V0.1.3, all protected baseline
**Date:** September 2026

---

## 1. Why this version exists

Three versions of integrity controls were verified by hand and recorded in delivery notes. That evidence was true on the day it was written and proved nothing thereafter. From V0.1.5 onward, every slice touches code that the registry's evidentiary value depends on, and a silent regression in any of about two dozen controls would not be noticed until a tester happened to repeat the right sequence.

This version converts those check tables into a suite that re-runs on every change.

## 2. What it covers

**41 tests, four spec files.**

| Spec | Covers |
|---|---|
| `auth.spec.ts` | Session boundary; role reporting; the three indistinguishable refusals; the audit trail recording their real reasons; HttpOnly cookie; undeclared-field rejection; sign-out invalidation; a live session ending when the account is disabled |
| `admin.spec.ts` | Administrator access; refusal for Directeur, Minister, Onder-Directeur and support staff; a non-administrator cannot self-grant; role assignment reaching the holder's own session; revocation preserving history; the last-administrator guard, and the same change succeeding once a second administrator exists |
| `records.spec.ts` | Draft with no reference or timestamp; the configured mandatory set; client-supplied identity and timestamp rejected; registration assigning server identity and time with the document date kept separate; distinct identities; double registration refused; post-registration edit refused; DEC-05 stale write and stale registration refused; registry closed to the administrator |
| `integrity.spec.ts` | Registry identity and timestamp immutability; registered-to-draft refusal; record intact after each rejected attempt; duplicate reference; half-registered rows; unknown direction; audit UPDATE and DELETE silently discarded; audit timestamps within server-time bounds |

**The suite runs against a real PostgreSQL instance, deliberately.** Most of what it protects is enforced by triggers, rules, check constraints and a unique index. A mocked repository would report success on every one of them. The specs attack the data the way a careless or compromised direct connection would, using the application's own credentials rather than a superuser.

The audit tests are written to verify rows afterwards rather than to assert that no error was thrown. The append-only rules report success and change nothing, so a test that only checked for an exception would pass against a table with no protection at all.

## 3. Verification status — including proof the suite can fail

A passing suite is not evidence on its own. Three controls were deliberately broken and the suite re-run:

| Mutation | Result |
|---|---|
| Sign-in message changed to reveal an unknown email | `✕ gives a byte-identical refusal for wrong password, unknown email and disabled account` |
| Optimistic version check removed from draft edits | `✕ refuses a stale write rather than silently overwriting (DEC-05)` |
| `audit_event_no_update` rule dropped from the database | `✕ silently discards an UPDATE against the history` |

Each mutation was caught by exactly the intended test and by no other, then reverted. The suite returned to 41 passing.

**Also verified:** `tsc --noEmit` clean; 4 suites, 41 tests, about 13 seconds, clean process exit.

## 4. Changes to existing code

Three, all to make the real system testable rather than to test a different one:

1. **`src/app-factory.ts` extracted from `main.ts`.** Both the server and the suite now build the application through one function, so the tests exercise the real middleware stack — the session cookie, the helmet headers, the validation pipe. A test harness that assembled its own stack would prove nothing about what is deployed.
2. **Seed data exported** from `src/seed/seed.ts`. The harness seeds the same nine actors from the same source rather than a copy that would drift.
3. **Session store shutdown** (`closeSessionStore`). The store owns a PostgreSQL pool separate from TypeORM's, which closing the application does not release — harmless for a long-running server, but it left the test process hanging.

TypeORM query logging is now silent under `NODE_ENV=test`, since the integrity specs provoke constraint errors on purpose.

## 5. Not verified, and open items

1. **No frontend tests.** Every check is API or database level. The screens were verified by hand in a browser across V0.1.1 to V0.1.3 and are not covered here. A component or end-to-end layer is a separate investment; I would not add it until the screens stop changing shape.
2. **No CI runner.** The suite exists but nothing runs it automatically. Whoever owns the repository should wire `npm test` into the pipeline; until then it protects only the person who remembers to run it.
3. **Specs share one database and run in band.** Correct and simple, but it means the suite cannot be parallelised without per-worker databases. Fine at this size; worth revisiting if it grows past a minute.
4. **The suite asserts no numbering format.** DEC-01 remains open, so the registration tests check uniqueness, immutability and server assignment only. When DEC-01 is decided, a format test should be added — and that is the moment to check it, not now.
5. **Audit write failure still does not fail the action.** Unchanged from V0.1.3 and now more visible: the suite proves events are written when everything works, not that an action is refused when the write fails.

## 6. Slice size

Approximately **560 lines** — harness 135, specs 425. Within the band. No product code was added; the three changes in §4 are refactors of roughly 40 lines in total.

## 7. Delivery contents

| Item | Path |
|---|---|
| Test suite | `backend/test/` |
| Test environment template | `backend/.env.test.example` |
| Jest configuration | `backend/jest.config.js` |
| How to run it | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.4.md` |
| Earlier notes, retained | `docs/DELIVERY-NOTE-V0.1.1.md` to `V0.1.3.md` |

**No tester guide this time.** There is nothing for a tester to click: this version adds no user-visible behaviour. The V0.1.3 guide remains the current one for manual testing.

## 8. Suggested commit message

```
V0.1.4 — automated integration test suite

41 tests across authentication, administration, registration and
database-level integrity, run against a real PostgreSQL instance because the
controls under test are triggers, rules, check constraints and a unique index
that a mocked repository would not exercise.

The audit tests verify rows after the attempt rather than asserting that an
error was thrown: the append-only rules report success and change nothing, so
an exception-only test would pass against an unprotected table.

Suite validated by mutation: revealing the unknown-email case, removing the
DEC-05 version check, and dropping the audit no-update rule each failed exactly
one intended test and no others.

Refactors to make the deployed stack testable rather than a substitute for it:
app-factory extracted and shared with main.ts, seed data exported for the
harness, session-store pool shutdown added.

No product behaviour added. No requirement coverage claimed beyond V0.1.3.
```

## 9. Next step

V0.1.5 — dossiers and record-to-dossier linking per FS-06, with DEC-11 (dossier identity) parameterised the same way DEC-01 is. This is where record-level permission evaluation becomes meaningful, and the first slice this suite will actually protect. Estimated 600–700 lines, plus tests extending `records.spec.ts` and `integrity.spec.ts` in the same slice rather than afterwards.
