# JusPol EDRMS — Delivery Note V0.1.15

**Slice:** Possible-duplicate warning at registration (FR-COR-016, OPTIONAL; TS-02 case 026)
**Gate:** None closes here. Side branch, alongside the Gate 1–3 testing round.
**Builds on:** V0.1.1 to V0.1.14, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered: before a draft is registered, the confirmation names any **registered** record that looks like the same thing, and why:

- **the same document** — a captured document with a byte-identical SHA-256 hash, whatever its filename;
- **the same subject and party** — same direction, and subject and party equal after ignoring case and surrounding spaces.

The user can still register. Doing so creates a second, separate record with its own reference. Nothing is merged, replaced, blocked or changed.

New route: `GET /api/records/:id/possible-duplicates`. Read-only.

Not in this version: fuzzy or partial subject matching, matching on document date, and duplicate warnings for dossiers (FS-04 UC-02 mentions a possible-duplicate dossier; no requirement asks for it in Delivery 1).

## 2. Decisions taken in the build, and why

1. **Advisory only, by design.** FR-COR-016 is OPTIONAL and says the system SHALL NOT silently merge or replace. TS-02 026 expects the warning not to "merge, block permanently, or alter either record". So the warning lives in the confirmation dialog; the question stays "register?", never "merge?".
2. **Only registered records are candidates.** A draft is preparatory material, not an official record something could duplicate.
3. **Exact matching, not fuzzy.** Fuzzy matching produces false alarms, and a warning that cries wolf gets clicked through. Two precise signals are more useful than one noisy one. Easy to widen later if the pilot shows real duplicates slipping past.
4. **A failed check never blocks registration.** If the lookup fails, the dialog says the check could not be run — it does not imply there are no duplicates — and registration proceeds on the user's choice.
5. **No constraint added.** Two indexes only (document hash, normalised subject). A unique constraint would be the forbidden merge by another route; V0.1.7 already chose not to add one on content_hash for the same reason.

## 3. Verification status

**Suite: 174 integration tests (thirteen spec files) and 33 component tests**, all passing on a schema rebuilt from empty. 7 integration and 5 component tests are new.

TS-02 026 expected results, each asserted:

| TS-02 026 | Test |
|---|---|
| A. Original not merged, overwritten, replaced or deleted | Full snapshot of the original — identity, subject, party, state, version, document hashes — is equal before and after |
| B. Two distinct records with two distinct identities | Asserted |
| C. Registry count up by exactly one | Asserted |
| D. Warning advisory only; alters neither record | Asking twice leaves audit, item, document counts and the draft's version unchanged |

**Mutation testing — five properties, all caught**

| Mutation | Result |
|---|---|
| Drafts become candidates | `✕ does not match across direction, across party, against drafts, or against itself` |
| A record matches itself | same |
| Direction ignored | same |
| Party ignored | same |
| Reasons not merged when both match | `✕ reports both reasons once when both match` |

The first run of the "drafts" mutation failed on a typo in my mutation script, not in the code, and was redone.

**Both production builds compile.** No live smoke run or browser walk-through for this slice.

## 4. Not verified, and open items

1. **Gate 4 dependency.** The warning names other records. Once FR-SEC-003 exists, each candidate must pass the permission evaluator before it is shown (UC-R04: no counts, snippets or context from records the user may not see). Today every business role sees every record, so nothing is disclosed that the registry list does not already show. The service comment says so at the point it matters.
2. **No browser walk-through** of the dialog text.
3. The warning is in a `window.confirm` dialog, like every other confirmation in the build. If the UI/UX standard later replaces those dialogs, this one moves with them.

## 5. Slice size

Approximately **480 lines** — backend 170, frontend 90, tests 220.

## 6. Suggested commit message

```
V0.1.15 — possible-duplicate warning at registration (FR-COR-016)

Before registering, the confirmation names registered records with a
byte-identical document or the same direction, subject and party. Advisory
only: registering still creates a separate record, nothing is merged or
changed, asking writes nothing, and a failed check never blocks. TS-02 026
expected results A to D asserted.
```
