# JusPol EDRMS — Delivery Note V0.1.11

**Slice:** Consolidation — audit hardening, component tests, cumulative re-audit
**Product behaviour added:** none. No requirement coverage is claimed beyond V0.1.10.
**Builds on:** V0.1.1 to V0.1.10, all protected baseline
**Date:** September 2026

---

## 1. Why this slice exists

Gate 4 is blocked on DEC-02, and three items had been on the open list long enough to become a pattern rather than a note: audit writes that failed without failing their action, no test coverage of the interface, and a cumulative re-audit that our agreed six-slice cadence made due now.

This slice does those three things and adds no features.

## 2. Audit hardening — the item carried since V0.1.2

Every action that changes authoritative state now writes its audit event **inside the same transaction as the change**. If the audit write fails, the action fails and leaves nothing behind.

| Action | Before | Now |
|---|---|---|
| Draft creation, registration | logged and continued | one transaction |
| Dossier creation, record linking | logged and continued | one transaction |
| Responsibility, due dates | logged and continued | one transaction |
| Document capture | logged and continued | one transaction |
| Document retrieval | logged and continued | strict — a failed access log fails the retrieval |
| Delegation grant and revocation | logged and continued | one transaction |
| Role assignment, revocation, account enable/disable | logged and continued | one transaction |
| Successful sign-in, sign-out | logged and continued | strict — no session without its record |
| Workflow decisions | already transactional (V0.1.10) | unchanged |

**Two writes remain deliberately lenient**, and both are reasoned rather than overlooked:

- **A refused sign-in.** The attempt is already being refused. A failure to record it must not become a different error that tells the caller something about why.
- **A failed document integrity check.** The retrieval is already being refused; turning an audit failure into a different error would hide the integrity problem, which is the more serious of the two.

**Tested for real.** A trigger is installed on `audit_event` that raises on every insert, and then the actions are attempted. Registration is refused and the item is still a draft with no identity. An account disable is refused and the account is still enabled. Sign-in itself is refused. Nothing proceeds unaudited.

## 3. Component tests — the item raised five times

**17 tests, no database, about two seconds.** They answer one question: given this state, does the screen offer the right controls to the right person. That is where every interface defect in this build occurred.

**Validated by reintroducing four defects that actually shipped or were caught by hand:**

| Reintroduced defect | Caught by |
|---|---|
| Controls gated on roles only, so delegated authority never reached the screen (V0.1.8) | `× offers the delegated action, and names whose authority is being used` |
| Ordinary-change controls offered on a finalised matter (V0.1.10) | `× withdraws every ordinary-change control once a matter is finalised` |
| History labels drawn from the state vocabulary (V0.1.9) | `× labels history events in their own vocabulary` |
| Finalise offered before approval | `× does not offer Finalise before approval` |

Each failed exactly one test and no others.

The API client is mocked on purpose. What the server permits is covered exhaustively by the 127 integration tests; these cover what the interface presents.

## 4. Cumulative re-audit

Per the agreed cadence, all earlier work re-verified together.

**Migrations.** The whole chain — eight migrations — rebuilds a correct schema from an empty database, and the full suite passes against it.

**Earlier mutations re-run, one per slice.** Every one still caught: the audit append-only rule (V0.1.2), the DEC-05 version check (V0.1.3), draft-into-dossier (V0.1.5), responsibility eligibility (V0.1.6), document integrity verification (V0.1.7), delegation revocation (V0.1.8), FR-FIN-003 protection (V0.1.10).

**And it found a real gap.** The V0.1.9 mutation — removing the FR-WFL-014 version binding — **passed everything**. On investigation: the existing test adds a record to the matter, which changes both the version *and* the content snapshot, so the snapshot comparison alone caught it and the version check was never exercised by itself.

There is a case only the version check can catch: a due-date change moves the version while leaving the linked records identical. Added that test; the mutation now fails it. Without the re-audit, the version check would have been quietly redundant coverage — present in the code, unprotected by any test, and removable by anyone tidying up.

**One thing I did badly and am recording.** I first attempted the re-audit as an ad-hoc SQL pass against the test database and got `UPDATE 0` from every attack, which looks like a rejection but means no rows matched — the tables were empty after the suite truncated them. That was inconclusive, not proof, and I discarded it. The suite's own attack tests are the evidence.

## 5. Open items after this slice

Closed here: audit-failure hardening, frontend test coverage, the scheduled re-audit.

Still open:

1. **No CI runner.** Now protecting 127 integration tests and 17 component tests, and still run only when someone remembers. This is the cheapest remaining improvement and it is not mine to make.
2. **HTTPS not exercised.** Unchanged since V0.1.1, and a deployment will hit it immediately: `NODE_ENV=production` makes the session cookie Secure.
3. **A matter can still be edited while under review.** Recorded rather than asserted, per TS05-TC-REVIEW-003. FR-WFL-014 protects the approval.
4. **Two lenient audit writes**, both reasoned in §2.
5. **No virus scanning on uploads.** A Ministry decision, raised at Gate 2.
6. **Dossier closure not modelled**, separate from processing finalisation. Belongs with retention.
7. **DEC-02 blocks Gate 4.** Six of the seven inputs to FR-SEC-003 exist.

Items 2, 5 and 7 are decisions or infrastructure for the client side; the rest are mine.

## 6. Slice size

Approximately **640 lines** — backend changes 260, component tests 300, test additions 80. Inside the band.

## 7. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, both test suites | `backend/`, `frontend/`, `backend/test/`, `frontend/src/**/*.test.tsx` |
| Component test configuration and mocks | `frontend/vitest.config.ts`, `frontend/src/test/` |
| Deployment and test instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.11.md` |
| Gate 2 and Gate 3 packs, all earlier notes | `docs/` |

No tester pack: no user-visible behaviour changed. The Gate 3 pack remains current.

## 8. Suggested commit message

```
V0.1.11 — consolidation: audit hardening, component tests, cumulative re-audit

Every action that changes authoritative state now writes its audit event in the
same transaction as the change, so a failed audit write fails the action.
Verified by installing a trigger that makes audit inserts raise: registration,
account changes and sign-in are all refused and leave nothing behind. Two writes
stay lenient by design — a refused sign-in and a failed integrity check, both
already failing for a better reason.

Adds 17 component tests covering what the interface offers per state and per
person, validated by reintroducing four defects that actually shipped. Each
failed exactly one test.

Cumulative re-audit: eight migrations rebuild the schema from empty, and one
earlier mutation per slice re-run. The V0.1.9 FR-WFL-014 mutation passed,
revealing that the version binding was never tested independently of the
content snapshot — a due-date change moves the version without changing the
records. Test added; the mutation now fails.

No product behaviour added. 127 integration tests, 17 component tests.
```

## 9. Next step

**Gate 4 remains blocked on DEC-02.** Without the sensitivity model, FR-SEC-003 cannot be built as anything but a partial implementation of the most consequential requirement in the baseline.

What can be built meanwhile, in rough order of value:

1. **The dossier timeline (BR-009), part of Gate 5.** The events all exist; the derived chronological view does not. It depends on Gate 4 only for filtering, so the derivation can be built now and filtered later.
2. **Search (FR-SRC), also Gate 5** — but this one genuinely should wait. Search must filter by the real permission rules, and building it against a placeholder means rewriting it.
3. **Nothing.** If DEC-02 is close, stopping the build and getting Gates 1 to 3 in front of testers is worth more than another slice. Three gates are finished and nobody outside this conversation has exercised any of them.

My recommendation is 3, then 1 if DEC-02 is still outstanding. But the testing decision is yours, and it has been available since Gate 1 closed at V0.1.2.
