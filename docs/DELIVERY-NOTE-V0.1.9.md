# JusPol EDRMS — Delivery Note V0.1.9

**Slice:** Submit, return for correction, approve (FR-WFL)
**Gate:** Gate 3 — Authority and workflow. **Not yet closed:** finalisation and reopen are V0.1.10.
**Builds on:** V0.1.1 to V0.1.8, all protected baseline
**Date:** September 2026

---

## 1. Scope, and the split I announced

The V0.1.8 note said Gate 3 would close at V0.1.9 or V0.1.10 and that I would say which rather than overrun silently. It is V0.1.10.

This slice delivers the decision flow: submit to a designated reviewer, return for correction with a reason, resubmit, approve. V0.1.10 takes finalisation (FR-FIN-001 to 004), reopen, and the Gate 3 tester pack.

Delivered:

- The FS-05 §3.2 processing states in use here — Active, Under Review, Returned, Approved — with only the FS-05 §3.4 transitions accepted
- Submission by support staff in their own right (FR-WFL-013), routing without acquiring decision authority
- A review queue per designated reviewer
- Return for correction with a required reason, preserved through later corrections (FR-WFL-007, FR-WFL-008)
- Resubmission with the whole prior chain intact and distinguishable (FR-WFL-009)
- Approval bound to the version and content that were actually reviewed (FR-WFL-014)
- Decision history, and three new audit event types
- 17 new tests

Not in this version: finalisation and reopen; Reject; multi-stage routing, which FR-WFL-011 explicitly says Delivery 1 must not require.

## 2. Two decisions deliberately not taken

**DEC-15 — whether Reject is enabled, and with what required reason. OPEN.** Reject is not built, and not hidden behind a flag either. FR-WFL-010 makes it conditional on Product Authority explicitly enabling it; building it would decide the question by default. Approve and Return for Correction are the PoC demonstration path FS-05 §3.2 names.

**Approval delegation is off by default.** The vocabulary exists (`APPROVE_ON_BEHALF`) because FR-WFL-006 allows an approval to record represented authority where acting on behalf is explicitly permitted. "Explicitly" is the operative word: it is absent from the default delegatable actions, so the grant itself is refused until configuration enables it. A test asserts that.

## 3. The control I want to draw attention to

**FR-WFL-014: what is approved must be what was reviewed.** TS-05 gives this requirement its heaviest coverage, and for good reason — an approval attached to content the approver never saw is worse than no approval at all.

At submission the matter is snapshotted: its subject, due date, the registered records linked to it, and the integrity references of their captured documents. Approval is bound to that snapshot and to the version. If a record has been filed into the matter since it was submitted, approval is **refused** with a message saying it must be resubmitted. The state stays Under Review. Verified, including the case where a second record is linked while the matter sits with the reviewer.

## 4. Requirements addressed

| Requirement | How |
|---|---|
| FR-WFL-001 | Four processing states in use, constrained in the database |
| FR-WFL-002 | Submission designates a named reviewer; a submission without one is refused by a check constraint |
| FR-WFL-003 | The submission event records actor, target reviewer, server time and version |
| FR-WFL-004 | Decision authority is evaluated per submission, not by seniority. The Minister is refused on a matter routed to the Onder-Directeur |
| FR-WFL-005 / 006 | Approval records approver, server time, outcome, the reviewed version, and represented authority where applicable |
| FR-WFL-007 | A return requires a reason — enforced in the service, the request validator and a check constraint |
| FR-WFL-008 | Corrections never touch the return event; it is append-only in the database |
| FR-WFL-009 | Resubmission preserves the full chain; the two submissions differ in time and version |
| FR-WFL-011 | One active review step. No multi-stage routing exists |
| FR-WFL-013 | Support staff prepare and route; routing confers no decision authority |
| FR-WFL-014 | Approval bound to the reviewed version and content snapshot |
| FR-SEC-010 | The administrator cannot reach the review queue or any decision history |

## 5. Verification status

**Suite: 114 tests, nine spec files, all passing** on a schema rebuilt from empty.

**Mutation testing — five controls, and one survived at first**

| Mutation | Result |
|---|---|
| Decision authority reduced to a role check, so seniority decides | `✕ lets support staff route a package…` and `✕ refuses a decision from anyone who is not the designated reviewer` |
| FR-WFL-014 binding removed | `✕ refuses to approve a matter that changed after it was submitted` |
| Reviewer authority check removed on submission | `✕ refuses submission to someone with no review authority, or to oneself` |
| State-transition trigger dropped from the database | `✕ refuses a state jump that FS-05 does not permit` and `✕ refuses a state change with no workflow event behind it` |
| Return-reason check removed from the service | **Survived.** |

The surviving one was worth chasing. The reason check exists in three places — request validator, service, check constraint — and my test used an empty string, which the validator catches, so removing the service check changed nothing. But the database constraint counts characters, and **whitespace passes it**: with the service check gone, a return reason of five spaces would have been accepted and stored as a reviewed decision. I added that case; the mutation now fails. Defence in depth is only defence if something tests the layer that actually catches the case.

**A bug of my own, found by the tests**

My first implementation refused every approval. The submission's own state change bumps the dossier version, and I was comparing the post-submission version against the version recorded at submission, so the matter always looked changed. The event now records the version the matter holds *while under review*, and a decision records the version it decided on. Worth recording because the fix is a semantic distinction, not a typo: "the version that was reviewed" is not "the version when the submit button was pressed".

**Database-level controls, attacked with the application's own credentials:** a state cannot jump from Active to Approved (`cannot move from ACTIVE to APPROVED`), a state cannot move with no event behind it, decision events cannot be edited or deleted (a reworded reason is silently discarded and the original survives), a return with no reason is refused, and a submission naming no reviewer is refused.

**Browser verification.** The full flow driven end to end: the assistant submits, the submitter is offered no decision controls, the Directeur sees a queue banner and an Approve button, returns it with a reason, and the state becomes Returned for correction. The decision history reads correctly with both events and the reason.

One cosmetic defect found and fixed: the history used the state vocabulary for event labels, so "SUBMITTED" rendered raw beside "Returned for correction". Separate label maps now.

## 6. Not verified, and open items

1. **Gate 3 is not closed.** No finalisation, so FR-WFL-012 — finalisation blocked without approval evidence — is not yet demonstrable, and there is no Gate 3 tester pack in this delivery.
2. **A submitter can still change a matter while it is under review.** TS05-TC-REVIEW-003 expected result E asks that this behaviour be *recorded* rather than asserted. Recorded here: editing is permitted, and FR-WFL-014 is what protects the approval — the change forces a resubmission rather than being silently approved. Whether it should be blocked outright is a Product Authority question, not one for me to settle.
3. **The snapshot covers structure, not document bytes.** It records the integrity references of the linked documents, so a substituted document would change the snapshot and force a resubmission. It does not itself store the content — the content is already immutable and hash-verified from V0.1.7.
4. **No notification to the reviewer.** They discover the queue on screen.
5. **No frontend tests.** Fourth slice running. The defect in §5 is cosmetic this time, but the pattern holds.
6. **No CI runner.** Unchanged, now protecting 114 tests.
7. **Audit write failure still does not fail the action.** Now spans decisions, which raises the stakes: an unaudited approval is a real gap. I would fix this in V0.1.10 alongside finalisation rather than carry it into Gate 4.
8. **HTTPS still not exercised.** Unchanged.

## 7. Slice size

Approximately **950 lines** — backend 520, frontend 190, tests 240. Well over the band, and the largest overrun so far.

I split the gate to avoid this and still overran. An honest account of why: the decision flow has an irreducible core. Submit without a decision is untestable, a decision without the version binding would ship FR-WFL-014 unimplemented, and the binding is what TS-05 weights most heavily. The database guards — transition legality and event-backed state changes — are another 130 lines that I was not willing to leave to application code.

If the rule matters more than the coherence, the honest split would have been submit-and-queue in one slice and decide-and-bind in the next, accepting that the first half is verifiable only by tests. Your call; I will take that route for V0.1.10 if you prefer it.

## 8. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, tests | `backend/`, `frontend/`, `backend/test/` |
| Deployment instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.9.md` |
| Earlier notes and the Gate 2 pack | `docs/` |

## 9. Suggested commit message

```
V0.1.9 — submit, return for correction, approve

Adds the FS-05 processing states in use and the decision flow over them. Only
the FS-05 §3.4 transitions are accepted, and a trigger refuses any state change
that no workflow event accounts for, so the state and its history cannot
diverge.

Decision authority is per submission, not per seniority: the designated
reviewer decides, and a more senior official routed nothing is refused.
Submission is support-staff work and confers no decision authority.

FR-WFL-014: the matter is snapshotted at submission — subject, due date, linked
records and their document integrity references — and approval is bound to that
snapshot and version. A matter changed since submission is refused with a
message to resubmit, rather than approved as content nobody reviewed.

A return requires a reason and is append-only; correcting the work never alters
it. Resubmission preserves the whole chain.

Reject is not built: DEC-15 is open (FR-WFL-010). Approval delegation is off by
default.

17 new tests. Five mutation checks; one survived initially because the return
reason is validated in three layers and the test only covered the case the
request validator catches — a whitespace-only reason would have passed. Covered
now.

Addresses FR-WFL-001 to 009, 011, 013, 014 and FR-SEC-010.
Gate 3 closes at V0.1.10 with finalisation and reopen.
```

## 10. Next step

**V0.1.10 — finalisation and reopen (FR-FIN-001 to 004), which closes Gate 3.** Finalisation must be blocked where the required approval evidence does not exist (FR-WFL-012), finalised evidence must be protected from ordinary change (FR-FIN-003), and reopening must be an explicit authorised event that never erases the finalisation it supersedes (FR-FIN-004).

I would also fix open item 7 in that slice — making an action fail when its audit write fails — before Gate 4 builds permission evaluation on top of it. And that slice carries the Gate 3 tester pack.
