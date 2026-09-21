# JusPol EDRMS — Delivery Note V0.1.5

**Slice:** Dossiers and record-to-dossier linking
**Builds on:** V0.1.1 to V0.1.4, all protected baseline
**Baseline:** FS-01 to FS-08 (FS-06 adopted per JUSPOL-ADD-C-01); TS-01 to TS-12; TS-ADDENDUM-01; JUSPOL-ADD-PKG-01
**Date:** September 2026

---

## 1. Scope

Delivered:

- Dossier per FS-06 §4 — the matter-level workspace, with a server-assigned identity, immutable once set
- Record-to-dossier linking (BR-004): a link, never a copy. One record may serve several matters
- Only a registered record may be linked. A draft cannot enter a matter file
- `DOSSIER_CREATED` and `RECORD_LINKED` audit events
- Dossier screen: open a dossier, see its contents, add a registered record
- 16 new tests, written inside this slice rather than after it

Not in this version: unlinking (see §2), dossier closure, responsibility assignment, review, search, record-level permission evaluation, document upload.

## 2. Two decisions deliberately not taken

**DEC-11 — dossier identity scheme. OPEN.** Pattern and padding come from configuration. The default `DOS-{YEAR}-{SEQ}` is a placeholder so the PoC runs. It is not a proposed scheme. The code asserts uniqueness, server assignment and immutability only, exactly as V0.1.3 handles DEC-01.

**DEC-10 — whether unlink/relink is enabled. OPEN.** No route removes a link, and none is hidden behind a flag either. Building it would decide the question by default, and un-deciding it later would mean removing a capability testers had already used. A test asserts that no such route exists, so if DEC-10 is later decided the test is replaced deliberately rather than quietly deleted.

## 3. Requirements addressed

| Requirement | How |
|---|---|
| FR-DOS-001 | A dossier is created as an open workspace for a matter; emptiness is stated plainly, not as an error |
| FR-DOS-002 | One identity per dossier, server-assigned from a sequence, unique index enforced, trigger rejects any later change |
| FR-DOS-003 / BR-004 | A record is linked to a dossier. The item row is not duplicated: two links to one record, verified by row count |
| FS-06 §3 (draft ≠ evidence) | Only a REGISTERED record can be linked. The interface omits drafts from the picker and explains why |
| FR-SEC-010 | SYS_ADMIN is absent from every dossier route. The administrator cannot read or create dossiers |
| FR-AUD family | Dossier creation and each link write an attributable, server-timed event |

## 4. Verification status

**Suite: 57 tests, five spec files, all passing.** 16 of them are new here.

**Mutation testing — and it found two problems in my own work**

| Mutation | First result | Action |
|---|---|---|
| Linking rule changed to accept drafts | **Inconclusive** — the spec failed to compile, so nothing ran | Redone with a valid mutation: `✕ refuses to link a draft` |
| `uq_dossier_link` constraint dropped from the database | **All 15 tests still passed** | A real gap: the duplicate-link test was only exercising the application's pre-check, so the constraint underneath it was untested. Added a direct-SQL test; the mutation now fails `✕ rejects a duplicate link at the database level, not only in the application` |

The second finding is the reason mutation testing is worth the time. A test named "refuses the same link twice" read as coverage of the constraint and was not. Had someone later removed the application check as redundant, nothing would have failed.

**A third problem surfaced during this.** Restoring the dropped constraint by hand failed silently, and the suite then reported one failure. That was correct behaviour: the schema really was missing the constraint. I rebuilt the test database from the migrations, which restored it properly and confirmed the migration chain builds a correct schema from empty. Worth recording because it is the kind of drift that makes a suite look flaky when it is actually right.

**Migration** `Dossiers1758400000000` applied clean on top of the existing pilot schema, and again from scratch on an empty database.

**Browser checks.** Dossier creation, registration and linking driven end to end. `DOS-2026-0001` assigned and displayed; a registered record added and listed with its reference; the draft correctly absent from the picker with the explanatory sentence shown; the administrator account sees no Dossiers section. One UX flaw was found and fixed before packaging: the picker still offered records already in that dossier, which produced a refusal the user could not act on.

## 5. Not verified, and open items

1. **Record-level permission evaluation still absent.** Every holder of a registering role sees every dossier and every record. FR-SEC-003, 005 and 006 remain unaddressed. The tester guide's internal tab says so explicitly, so broad visibility is not reported as a defect.
2. **No dossier timeline.** FS-06 expects a readable chronological view derived from events (BR-009). The events exist; the derived view does not.
3. **No frontend tests.** Unchanged from V0.1.4.
4. **No CI runner.** Unchanged, and now protecting 57 tests instead of 41. This is the cheapest remaining improvement available to you.
5. **Audit write failure still does not fail the action.** Unchanged.
6. **HTTPS still not exercised.** Unchanged.

## 6. Slice size

Approximately **680 lines** — backend 340, frontend 130, tests 210. Within the band, tests included, which is the point: the slice carries its own coverage rather than deferring it.

## 7. Delivery contents

| Item | Path |
|---|---|
| Backend source | `backend/` |
| Frontend source | `frontend/` |
| Test suite | `backend/test/` |
| Deployment instructions, including the DEC-11 parameters | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.5.md` |
| Earlier notes, retained | `docs/DELIVERY-NOTE-V0.1.1.md` to `V0.1.4.md` |
| Tester guide, 20 steps, expected outcomes on a hidden tab | `docs/JusPol-EDRMS-V0.1.5-Tester-Guide.xlsx` |

## 8. Suggested commit message

```
V0.1.5 — dossiers and record-to-dossier linking

Adds Dossier per FS-06 with a server-assigned identity protected by a unique
index and a trigger, and dossier_link as a link table: one record may belong to
several dossiers and is never duplicated to support navigation (BR-004).

Only a registered record may be linked. A draft cannot enter a matter file,
where it could be mistaken for evidence of that matter. The interface omits
drafts from the picker and states why rather than hiding them silently.

Dossier identity syntax comes from configuration (DEC-11 open, placeholder
default). Unlinking is not built at all (DEC-10 open); a test asserts no such
route exists, so enabling it later is a deliberate change.

16 new tests. Mutation testing revealed that the duplicate-link test covered
only the application pre-check and not the database constraint; a direct-SQL
test was added, which the mutation now fails.

Addresses FR-DOS-001 to 003, BR-004, FR-SEC-010 and the FR-AUD attribution
requirements for dossier events.
```

## 9. Next step

Two candidates, and I would take the first:

**V0.1.6 — responsibility and due dates (FR-RES family).** Assigning official responsibility for a dossier or record, with due dates where used, and the events that make a change traceable (BR-006). This is the next thing a Head Office pilot actually needs in order to be used at all, and it is what makes the registry more than a filing cabinet. Estimated 600–700 lines including tests.

**Record-level permission evaluation (FR-SEC-003)** is the alternative, but it depends on DEC-02 for the sensitivity model, and organisational scope rules that the frozen baseline leaves to configuration. It can be built on responsibility and unit ownership alone, but the result would be a partial implementation of a requirement that later needs revisiting — I would rather build it once, after responsibility exists and DEC-02 is settled.
