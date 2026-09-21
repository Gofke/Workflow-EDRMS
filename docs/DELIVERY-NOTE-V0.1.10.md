# JusPol EDRMS — Delivery Note V0.1.10

**Slice:** Finalisation, reopening, and audit-backed decisions
**Closes:** Gate 3 — Authority and workflow
**Builds on:** V0.1.1 to V0.1.9, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered:

- Finalisation of an approved matter, refused where the required approval evidence does not exist (FR-WFL-012, FR-FIN-001, FR-FIN-002)
- Finalised results protected from ordinary change: responsibility, due date and record linking all refuse until the matter is reopened (FR-FIN-003)
- Reopening as an explicit, reasoned, authorised event that never erases the finalisation it supersedes (FR-FIN-004)
- Finalisation and reopening restricted to decision-making roles — support staff may route work, not close it or undo its closure
- **Every workflow decision and its audit event are now written in one transaction.** This closes the open item carried since V0.1.2
- 10 new tests, 124 in total

Not in this version: Reject (DEC-15 open); dossier closure as distinct from processing finalisation; retention.

## 2. The audit-failure fix, and its limits

Since V0.1.2 an audit write that failed was logged loudly and the action proceeded. That was defensible for a draft or a role change and indefensible for an approval: an authoritative state with no evidence behind it.

Workflow decisions — submit, return, approve, finalise, reopen — now write the workflow event, the state change and the audit event inside a single transaction. If the audit write fails, the decision fails with it. A test asserts the counts move together, and a mutation removing the audit write from the transaction fails five tests.

**What is not fixed:** registration, document capture, delegation grants, role changes and due-date changes still log and continue. Those need the same treatment, and doing them all here would have been another 200 lines across six services. Recorded as the remaining open item rather than quietly declared done.

## 3. Requirements addressed

| Requirement | How |
|---|---|
| FR-WFL-012 | Finalisation refused unless an approval event exists. An approval against an earlier version does not carry forward |
| FR-FIN-001 | An authorised decision-maker finalises when the approval exists |
| FR-FIN-002 | The finalisation event records actor, server time, the approval it rests on and that approval's version |
| FR-FIN-003 | Responsibility, due date and record linking all refuse on a finalised matter, in the service and in the interface |
| FR-FIN-004 | Reopening is a separate event with a required reason; the finalisation stays in the history and the matter can go round again |
| FR-SEC-008 | Support staff cannot finalise or reopen |
| FR-AUD family | Decisions and their audit events are transactionally inseparable |

## 4. Verification status

**Suite: 124 tests, nine spec files, all passing** on a schema rebuilt from empty.

**Mutation testing — four controls, all caught**

| Mutation | Result |
|---|---|
| FR-WFL-012 removed — finalise without approval evidence | `✕ refuses to finalise a matter that has not been approved` |
| FR-FIN-003 protection removed from responsibility and due dates | `✕ protects a finalised matter from ordinary change` |
| Reopen role check removed | `✕ refuses finalisation and reopening to support staff` |
| Audit write removed from the decision transaction | **five tests failed**, including `✕ writes each decision and its audit event together` |

**Database-level controls:** a state cannot jump from Active to Finalised, a reopening with no reason is refused by a check constraint, and the full state machine — including the two new transitions — is enforced by the trigger rather than by application code.

**The full life of a matter, verified end to end in the browser:** submitted by an assistant → returned with a reason → resubmitted → approved → finalised → reopened. The decision history reads `Submitted for review / Approved / Finalised / Reopened`, with the finalisation still present after the reopening.

Also verified: support staff never see Finalise; Finalise does not appear before approval; and on a finalised matter the responsibility picker, due-date box and add-record row are all withdrawn.

**One UI defect found and fixed:** the finalised matter still offered the responsibility picker and the add-record row. The server refused both, so nothing could have been corrupted, but an interface that invites a refusal is a defect. Both withdrawn.

## 5. Gate 3 status

**Closed.** The Gate 3 pack in this delivery is 27 steps covering the whole domain: a Directeur delegating scoped authority, an assistant acting under it, a full review round with a return and a correction, approval, finalisation, reopening, and revocation of the delegation.

Two steps carry the weight. Step 7 asks the tester to copy the responsibility line verbatim — it must name the assistant who acted **and** the Directeur whose authority was used. Step 22 asks whether the Finalised line survives the reopening.

The pack includes a "Not in this gate" tab, which now matters more than at Gate 2: there is no Reject button, approval cannot be delegated, only one review step exists, and a matter can still be edited while under review — the refusal that produces is correct behaviour and the tab says so.

**Consolidated build:** this ZIP is the whole application at Gate 3, V0.1.1 to V0.1.10, with the full suite run against it.

## 6. Not verified, and open items

1. **Audit-failure hardening is partial.** §2. The remaining six services still log and continue. I would finish this before Gate 4 rather than after.
2. **No frontend tests.** Fifth slice running, and the defect in §4 is again exactly what one would catch. I have raised this five times; it is now a standing recommendation rather than a note.
3. **A matter can still be edited while under review.** Unchanged from V0.1.9, and recorded rather than asserted per TS05-TC-REVIEW-003. FR-WFL-014 is what protects the approval.
4. **No CI runner.** Unchanged, now protecting 124 tests.
5. **HTTPS still not exercised.** Unchanged, and it is the one item on this list that a deployment will hit immediately.
6. **Dossier closure is not modelled.** FS-05 §3.3 has Open, Closed and Reopened for the dossier itself, separate from the processing state finalised here. Not needed for Gate 3; it belongs with retention.

## 7. Slice size

Approximately **620 lines** — backend 300, frontend 90, tests 230. Inside the band, after two overruns.

## 8. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, tests | `backend/`, `frontend/`, `backend/test/` |
| Deployment instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.10.md` |
| Gate 3 tester pack, 27 steps | `docs/JusPol-EDRMS-Gate-3-Tester-Guide.xlsx` |
| Gate 2 pack and all earlier notes | `docs/` |

## 9. Suggested commit message

```
V0.1.10 — finalisation and reopening; closes Gate 3

Finalisation requires the approval evidence to exist (FR-WFL-012) and records
the approval it rests on, including that approval's version. A finalised matter
refuses ordinary change — responsibility, due date and record linking all stop
until it is reopened (FR-FIN-003) — and the interface withdraws those controls
rather than inviting a refusal.

Reopening is an explicit, reasoned, authorised event. The finalisation stays in
the history and the matter can go round again, so the sequence
submit/approve/finalise/reopen/submit/approve/finalise reads correctly.

Workflow decisions now write the event, the state change and the audit entry in
one transaction: an unaudited approval is no longer possible. Registration,
capture, delegation and role changes still log and continue — see the delivery
note.

10 new tests, 124 in total. All four mutation checks caught; removing the audit
write from the decision transaction fails five tests.

Addresses FR-WFL-012, FR-FIN-001 to 004, FR-SEC-008 and the FR-AUD family.
```

## 10. Next step

Gate 4 is **blocked on DEC-02**, the sensitivity and need-to-know model. Six of the seven inputs to FR-SEC-003 now exist; sensitivity cannot be invented.

So my recommendation for V0.1.11 is the work that does not depend on it, and it is all housekeeping I have been listing rather than doing:

- Finish the audit-failure hardening across the remaining services
- Add the thin frontend test layer — five slices of UI defects make the case
- The cumulative re-audit that falls due around now under the agreed cadence: every earlier control re-attacked, every earlier mutation re-run, every open item across ten delivery notes reviewed and either closed or restated

That is a consolidation slice rather than a feature slice, and it lands exactly where the six-slice re-audit was scheduled. If DEC-02 is settled in the meantime, Gate 4 opens straight after it.
