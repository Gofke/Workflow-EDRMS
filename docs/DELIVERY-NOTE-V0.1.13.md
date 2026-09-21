# JusPol EDRMS — Delivery Note V0.1.13

**Slice:** Dossier closure and reopening (FR-DOS-006, 007, 008; FR-FIN-004; EV-DOS-CLOSE; UC-15)
**Gate:** None closes here. Built on a side branch while the Gate 1–3 testing round runs.
**Builds on:** V0.1.1 to V0.1.12, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered: the matter file has its own state, separate from the processing state.

| Transition | Condition |
|---|---|
| Open → Closed | The matter is finalised. Reason optional. |
| Closed → Reopened | A reason is required. |
| Reopened → Closed | The matter is finalised again. |

While a dossier is Closed it stays readable — list, timeline, decision history, responsibility history — and nothing about it can change: no record linked, no responsibility assigned, no due date set, no workflow move, including a workflow reopening.

Reopening the file does **not** reopen the work. A reopened dossier whose matter needs redoing is then reopened in the workflow, as its own reasoned decision. Two decisions, two events, both visible.

Not in this version: retention, disposal, archive (DEC-04 and later). Closure authority is not delegatable.

## 2. Decisions taken in the build, and why

1. **Closure requires a finalised matter.** FS-03 T-06 and the UC-15 precondition require the authoritative result to exist before closure. A stricter reading was available (closure implies finalisation in one step) and was not taken: finalising and closing are separate FS-03 events.
2. **Who may close is configuration, not a position.** FS-01 §14 item 7 leaves close/reopen authority open, and FS-03 lists it as Delivery 1 configuration. `DOSSIER_CLOSURE_ROLES` defaults to the three decision roles — the same people who may finalise. Narrow, because a closure granted in the pilot cannot be un-granted from history.
3. **Not delegatable.** DEC-13 governs delegation and its defaults do not include closure. Adding it would decide that question too.
4. **Reject was not built alongside.** It was on the draft slice list, but `workflow-config.ts` records that building Reject behind a flag would decide DEC-15 by default. That reasoning stands; the item is withdrawn from the run.

## 3. Protections, and where they live

In the database, so no code path can bypass them:

- `dossier_state_event` is append-only (UPDATE and DELETE are no-ops by rule).
- A trigger accepts only the three transitions, only closes a finalised matter, and refuses any state change that has no state event behind it.
- While Closed, the dossier's subject, due date and processing state cannot change.
- Inserts into `dossier_link`, `responsibility_assignment`, `due_date_change` and `workflow_event` are refused for a closed dossier.
- A reopening event without a reason violates a check constraint.

In the service, so the user gets a sentence rather than a trigger error: every refusal above returns 400 with a message naming the closure.

## 4. Verification status

**Suite: 157 integration tests (eleven spec files) and 25 component tests**, all passing on a schema rebuilt from empty. 20 integration and 5 component tests are new.

**Mutation testing — four properties, all caught**

| Mutation | Result |
|---|---|
| Workflow ignores a closed file (service guard removed) | `✕ refuses every ordinary change to a closed dossier` |
| Database lets rows be added to a closed file | `✕ refuses edits and additions to a closed dossier` |
| Timeline silently drops the new source | `✕ puts closing and reopening in the timeline, counted against the source`, plus one |
| State history shows only the latest event (closure "erased" by reopening) | `✕ reopens without erasing the closure, and can close again`, plus one |

**One existing test changed, intentionally.** `dossiers.spec.ts › rejects a state the pilot does not recognise` used `CLOSED` as its unknown state. `CLOSED` is now valid. The test keeps its assertion (`ck_dossier_state`) with a genuinely unknown value, `ARCHIVED`, inserted rather than updated so the check constraint answers rather than the new trigger.

**Timeline count test extended.** `accounts for every authoritative event exactly once` now counts `dossier_state_event` too, so dropping the new source fails it.

**Both production builds compile.** No browser verification was run in this environment.

## 5. Not verified, and open items

1. **No browser walk-through.** The component tests cover what the panel offers per state and role; nobody has clicked through it.
2. **Close/reopen authority is still a placeholder** until the Ministry decides.
3. **No closure tester pack.** Gate 3's pack does not cover it. Worth a short addition after the current round.
4. Unchanged: DEC-02 blocks Gate 4; no permission filtering on the timeline; three overlapping history views; no timeline paging or export (next slice).

## 6. Slice size

Approximately **720 lines** — migration 150, backend 230, frontend 140, tests 330 (incl. one changed). Slightly above the usual band because the database protections are written out.

## 7. Suggested commit message

```
V0.1.13 — dossier closure and reopening (FR-DOS-006 to 008)

The matter file gets its own state: Open, Closed, Reopened. Closure needs a
finalised matter; reopening needs a reason and never erases the closure it
follows. While closed the file is readable and nothing about it can change,
enforced in the database as well as the service. Close/reopen authority is
configuration (DOSSIER_CLOSURE_ROLES) because the decision is open.
```
