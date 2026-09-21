# JusPol EDRMS — Delivery Note V0.1.6

**Slice:** Responsibility and official due dates (FR-OWN)
**Builds on:** V0.1.1 to V0.1.5, all protected baseline
**Baseline:** FS-01 to FS-08 (FS-06 adopted per JUSPOL-ADD-C-01); TS-01 to TS-12; TS-ADDENDUM-01; JUSPOL-ADD-PKG-01
**Date:** September 2026

---

## 1. Scope

Applied to dossiers — the matter level. Responsibility for an individual record is not modelled; FR-OWN-001 says "matter/item", and the matter is what a Head Office pilot actually assigns.

Delivered:

- One unambiguous current responsibility per matter (FR-OWN-001), enforced by a partial unique index
- Assignment and reassignment within authority (FR-OWN-002), preserving the previous owner, the actor who assigned them and the server time (FR-OWN-003)
- Official due date where the matter requires one (FR-OWN-004, 005)
- Due-date changes preserving old value, new value, actor, server time and a reason where configuration requires it (FR-OWN-006). Removal is a change to no date — an event, not an erasure
- An assignment picker listing only officials who may carry responsibility, by name
- Four new audit event types
- 15 new tests

Not in this version: delegation and acting-on-behalf (FR-DEL), responsibility at record level, ageing or overdue views, review and approval, record-level permission evaluation.

## 2. Two boundaries held deliberately

**Support staff cannot assign responsibility or set a deadline.** They prepare and register work without acquiring authority (FR-SEC-008), and acting for a principal requires an explicit delegation that FR-DEL-005 says must be granted, not assumed. Adding support staff to the assigning roles would grant by default exactly what FR-DEL requires be granted explicitly. They can see who is responsible and what is due — that is FR-OWN monitoring, not authority.

**DEC-12 — which due-date changes require a reason. OPEN.** Configurable as `always`, `change` or `never`. The default `change` asks for a reason when an existing deadline moves or is removed but not when one is first set. That is a placeholder, not a recommendation.

**FR-OWN-007** (Task Management may mirror but never own responsibility) needs no code here: no integration exists, and nothing outside the EDRMS can write either value.

## 3. Verification status

**Suite: 71 tests, six spec files, all passing** on a schema rebuilt from empty by the migration chain.

**Mutation testing — four attempts, two of which taught me something**

| Mutation | Result |
|---|---|
| `ix_responsibility_one_current` index dropped | `✕ refuses a second live assignment inserted directly (FR-OWN-001)` — caught |
| Reassignment deletes the superseded row instead of keeping it | **All tests still passed.** Investigated rather than assumed: the `responsibility_assignment_no_delete` rule made the deletion a no-op, so the control held at the database layer and the application-level attempt was neutralised. Not a coverage gap — the rule itself is covered by its own test — but it is a mutation the suite alone would not have caught, and worth recording as such |
| DEC-12 reason requirement removed | First attempt broke compilation, so nothing ran and the result was **inconclusive, not a pass**. Redone properly by setting `DUE_DATE_REASON_REQUIRED_ON=never`: `✕ sets a first due date without a reason, then requires one to change it (DEC-12)` — caught |
| Eligibility list widened to include support staff and the administrator | `✕ refuses responsibility for someone whose role cannot carry it` — caught |

**Database-level controls, attacked with the application's own credentials**

| Attempt | Result |
|---|---|
| Insert a second live assignment for one dossier | rejected by the partial unique index |
| Rewrite an assignment row's responsible party | `ERROR: an assignment record cannot be rewritten` |
| Delete an assignment row | silently discarded; row count unchanged |
| Edit or delete due-date history | silently discarded; original value intact |
| Move a dossier's due date with no history row behind it | `ERROR: a due date change must be recorded in due_date_change first` |

That last one is the control I am most pleased with: the current due date cannot drift away from its own history, because the trigger refuses a change that no recorded event accounts for.

**Browser verification — and a real defect found**

The first responsibility assignment silently did nothing while a second attempt succeeded. I traced it rather than re-running until it passed: the API was returning 200 with the correct owner every time, so the fault was in the screen. The officials list loads asynchronously and its arrival re-rendered the picker, discarding a selection made while the fetch was in flight. The assignment controls are now withheld until that list has arrived, with a brief loading line in their place.

Re-verified after the fix: assign, set due date, reassign, change due date with a reason — all correct, and the history shows `A. Boldewijn (superseded)` above `R. Dijkstra (current)`, which is FR-OWN-003 doing its job. Support staff see the responsible party and the due date but no assignment controls.

I also record, so it is not lost: two of my earlier browser scripts produced results that looked like product defects but were races in the test script itself. A silent failure in a UI check is worth tracing to its cause before believing either the pass or the fail.

## 4. Not verified, and open items

1. **No delegation (FR-DEL).** This is the largest remaining gap in this domain, and TS-04 gives it six requirements and its own P0 weight — an action performed under delegated authority must record both the actual actor and the represented authority. Nothing here does that, because nothing here delegates. **My recommendation for V0.1.7.**
2. **No ageing or overdue view.** FR-OWN monitoring (OWN-06) is served only by the value shown per dossier. A Directeur cannot yet see what is due across matters.
3. **Responsibility is matter-level only.** Item-level responsibility is not modelled.
4. **No frontend tests.** Unchanged. The defect in §3 is exactly what a component test would have caught, and it is the strongest argument yet for adding a small one.
5. **No CI runner.** Unchanged.
6. **Audit write failure still does not fail the action.** Unchanged, and now covering responsibility changes too.
7. **HTTPS still not exercised.** Unchanged.

## 5. Slice size

Approximately **700 lines** — backend 360, frontend 140, tests 200. At the top of the band.

## 6. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, tests | `backend/`, `frontend/`, `backend/test/` |
| Deployment instructions, including the DEC-12 parameter | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.6.md` |
| Earlier notes, retained | `docs/DELIVERY-NOTE-V0.1.1.md` to `V0.1.5.md` |
| Tester guide, 20 steps, expected outcomes on a hidden tab | `docs/JusPol-EDRMS-V0.1.6-Tester-Guide.xlsx` |

## 7. Suggested commit message

```
V0.1.6 — responsibility and official due dates

One unambiguous current responsibility per matter, enforced by a partial unique
index rather than by application logic. Reassignment supersedes the previous
assignment inside a transaction: the earlier owner, the actor who assigned them
and the time survive, and a trigger refuses any attempt to rewrite or revive an
assignment row.

Official due dates with full change history: old value, new value, actor,
server time, and a reason where configuration requires one. Removal is a change
to no date, recorded as an event. A trigger refuses a due-date move on the
dossier unless a matching history row exists, so the current value cannot drift
from its own history.

Assignment and deadline authority is limited to Directeur, Onder-Directeur and
Minister. Support staff are excluded deliberately: acting for a principal needs
an explicit delegation (FR-DEL-005), which Delivery 1 has not built.

DEC-12 is parameterised (always | change | never), defaulting to a reason on
changes to an existing deadline. Placeholder, not a recommendation.

15 new tests. Mutation testing caught the index, the DEC-12 rule and the
eligibility list; one mutation was neutralised by the delete rule and is
recorded as such rather than as a pass.

Fixes a UI race where the officials list loading mid-interaction discarded the
user's selection, so the first assignment silently did nothing.

Addresses FR-OWN-001 to 006. FR-OWN-007 needs no code: no integration exists.
```

## 8. Next step

**V0.1.7 — delegation and acting on behalf (FR-DEL).** Six requirements, and the one that carries the weight is FR-DEL-003: an action performed under delegated authority must record both the authenticated actor and the represented authority, so accountability never blurs. It also unblocks what support staff can legitimately do, which is the most likely thing a Head Office pilot will ask for the moment real users touch this. DEC-13 (the delegation capability matrix) is open and would be parameterised the same way DEC-01, DEC-11 and DEC-12 are.

Estimated 650–700 lines including tests, and I would add a small frontend test layer alongside it given what §3 turned up.
