# JusPol EDRMS — Delivery Note V0.1.12

**Slice:** The dossier timeline (BR-009)
**Gate:** Gate 5 — Retrieval. Not closed: search is the other half, and it waits on Gate 4.
**Builds on:** V0.1.1 to V0.1.11, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered: one chronological account of a matter, readable end to end without reconstructing it from several screens — which is the whole point of BR-009 and of OWN-06 before it.

Seven sources feed it: the dossier's own opening, responsibility assignments, due-date changes, records filed into the matter, the registration of those records, documents captured against them, and every workflow decision.

Not in this version: search (FR-SRC), permission filtering of timeline content, export.

## 2. The property that matters: derived, not stored

The timeline is a single SQL query over the authoritative rows. Every entry comes from a row that already carries its own server time and actor. Nothing is written when a timeline is read, and no entry exists that some authoritative row did not produce.

This is not an implementation detail. A timeline **stored** as its own narrative would be a second version of history, free to drift from the first — and the drift would surface exactly when someone needed the account to be trustworthy. This one cannot disagree with the record, because it is the record read in order.

Two consequences worth stating:

- A test asserts the entry count against the **source tables**, not against a fixed number. It still holds when a later slice adds a new kind of event, and it fails if any source is silently dropped.
- Another test asserts that the workflow events in the timeline match the workflow history endpoint exactly, in order. The two views cannot diverge.

One deliberate omission: the supersession of a responsibility assignment is not its own entry. It is implied by the next assignment, and emitting both would report one change twice.

## 3. Verification status

**Suite: 137 integration tests (ten spec files) and 20 component tests**, all passing on a schema rebuilt from empty.

**Mutation testing — four properties, all caught**

| Mutation | Result |
|---|---|
| A whole source silently omitted (document captures) | `✕ accounts for every authoritative event exactly once`, plus two others |
| Chronological ordering dropped | `✕ reads in order, opening first and finalisation last` and `✕ cannot disagree with the workflow history it derives from` |
| Represented authority dropped from an entry | `✕ shows an action taken under delegated authority with both names` |
| A duplicate entry emitted per record link | `✕ accounts for every authoritative event exactly once` |

The first and last are the two failure modes a timeline actually has — losing an event, or reporting one twice — and the count-against-sources test catches both.

**Also verified:** reading a timeline twice writes nothing, to either the audit table or the workflow events. A new matter shows exactly one entry, its opening. The administrator is refused (403); an unknown dossier gives 404.

**Browser verification.** A matter that had been through the whole flow in earlier runs read back correctly: opened, submitted for review to M. Sardjoe, approved, finalised, reopened with its reason — in order, with each actor named.

## 4. Not verified, and open items

1. **No permission filtering.** FR-DOS-009 requires record-level restrictions to be evaluated when records are seen through a dossier, and specifically that a denied object must not leak through a relationship list. This timeline shows what the dossier contains to anyone who may open the dossier. **The query will need revisiting when the FR-SEC-003 evaluator exists**, and the service comment says so at the point where it matters. This is the one place in the build where a Gate 4 dependency is visible in shipped code rather than absent from it.
2. **Three overlapping history views now exist:** the timeline, the responsibility/due-date "Show history", and the workflow "Decision history". The timeline subsumes both. I have **not** consolidated them, because the Gate 2 and Gate 3 tester packs instruct testers to click those exact labels, and neither pack has been run yet. Consolidating now would invalidate two written packs to tidy a duplication nobody has complained about. Worth doing after the gate rounds, not before.
3. **No paging.** A matter with hundreds of events returns all of them. Fine at pilot scale; a real concern later.
4. **No export.** Reading the account in the interface is not the same as handing it to someone.
5. Unchanged and still open: no CI runner; HTTPS not exercised; a matter can be edited while under review (recorded, not asserted); two lenient audit writes; no virus scanning; dossier closure not modelled; **DEC-02 blocks Gate 4**.

## 5. Slice size

Approximately **560 lines** — backend 250, frontend 130, tests 180. Inside the band.

## 6. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, both test suites | `backend/`, `frontend/`, `backend/test/`, `frontend/src/**/*.test.tsx` |
| Deployment and test instructions | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.12.md` |
| Gate 2 and Gate 3 packs, all earlier notes | `docs/` |

No tester pack: Gate 5 does not close here, and the Gate 3 pack remains current. The timeline is worth a look during the Gate 3 round even though its steps do not cover it.

## 7. Suggested commit message

```
V0.1.12 — the dossier timeline (BR-009)

One chronological account of a matter, derived rather than stored: a single
query over the authoritative rows, each of which already carries its own server
time and actor. Reading a timeline writes nothing, and no entry exists that no
row produced — a stored narrative would be a second version of history, free to
drift from the first.

Seven sources: the dossier's opening, responsibility assignments, due-date
changes, record links, registrations, document captures, workflow decisions.
Supersession of a responsibility assignment is deliberately not its own entry.

Tests count entries against the source tables rather than against a fixed
number, so the assertion survives new event kinds and fails on a silently
dropped source. A second test pins the timeline's workflow entries to the
workflow history endpoint, in order, so the two views cannot diverge.

All four mutation checks caught: an omitted source, lost ordering, lost
represented authority, and a duplicated entry.

No permission filtering yet — FR-DOS-009 needs this query revisited once the
FR-SEC-003 evaluator exists, and the service says so where it matters.
```

## 8. Next step

There is no further slice I can honestly recommend building.

Search is the other half of Gate 5 and it should wait: it must filter by the real permission rules, and building it against a placeholder means writing it twice. Gate 4 needs DEC-02. Gate 6 is Task Management mirroring and AI assistance, both explicitly non-authoritative and both sensibly last.

What is left is not code:

- **DEC-02.** It blocks the most consequential requirement in the baseline. Gates 2 and 3 were meant to be the window for settling it.
- **Testing.** Three gates are finished and three tester packs are written. Twelve slices of my own verification — 137 integration tests, 20 component tests, forty-odd mutations — is a different thing from one inexperienced tester doing something I did not anticipate.
- **A CI runner**, so the suites protect the build rather than protecting whoever remembers to run them.

If you want another slice regardless, the honest options are small: paging and export on the timeline, or the dossier closure state. Both are real but neither is on the critical path, and I would rather say so than manufacture momentum.
