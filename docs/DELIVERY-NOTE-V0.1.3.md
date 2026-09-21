# JusPol EDRMS — Delivery Note V0.1.3

**Slice:** Correspondence items — draft capture, official registration, protected registry identity
**Builds on:** V0.1.1 (identity) and V0.1.2 (audit, administration), both now protected baseline
**Baseline:** FS-01 to FS-08 (FS-06 adopted per JUSPOL-ADD-C-01); TS-01 to TS-12; TS-ADDENDUM-01; JUSPOL-ADD-PKG-01
**Date:** September 2026

---

## 1. Scope change from what V0.1.2 announced

The V0.1.2 note proposed V0.1.3 as the whole records model: correspondence items **and** dossiers **and** linking. On building it, that came to well over 1,000 lines and breaks the agreed slice size.

This version therefore delivers **correspondence items and registration only**. Dossiers and record-to-dossier linking move to V0.1.4. Recorded here as an intentional re-scope under Manual §4.1, not a silent cut.

Delivered:

- Correspondence Item per FS-06 §4, in the three FR-COR-001 directions
- Draft state distinct from registered state, visibly different in the interface
- Registration: server-assigned official identity, server-authoritative registration time
- Document date stored separately from registration time (BR-002)
- DEC-05 optimistic version check applied to draft edits and to registration
- Configured numbering pattern (DEC-01) and configured mandatory metadata set (DEC-08), neither decided in code
- `DRAFT_CREATED` and `ITEM_REGISTERED` audit events
- Last-administrator guard, which was V0.1.2's open item 1

Not in this version: dossiers and linking, document/file upload, responsibility assignment, review and approval, search, record-level permission evaluation, sensitivity.

## 2. Open decisions — parameterised, not decided

| Decision | Status | How this version handles it |
|---|---|---|
| DEC-01 registration numbering scheme | OPEN | Pattern, padding and direction markers come from configuration. The default `{DIRECTION}-{YEAR}-{SEQ}` is a neutral placeholder. **It is not a proposed scheme and should not be read as one.** The code asserts uniqueness, immutability and filename-independence only |
| DEC-08 minimum mandatory metadata set | OPEN | The configured set is enforced; the default is `subject` alone. Nothing asserts which fields ought to be mandatory |
| DEC-05 concurrency model | RESOLVED | Implemented as selected: optimistic version check on every update and on registration |
| DEC-02 sensitivity, DEC-11 dossier identity | OPEN | Not reached by this version |

## 3. Requirements addressed

| Requirement | How |
|---|---|
| FR-COR-001 | Incoming, outgoing and internal as distinct directions, constrained in the database |
| FR-COR-002 | One unique identity per registered item, assigned by the server from a sequence, unique index enforced. No filename is involved anywhere |
| FR-COR-003 | `registered_at` set by the database with `now()`; `document_date` is a separate user-supplied field |
| FR-COR-004 | A trigger rejects any change to identity or registration time once assigned, and rejects returning a registered item to draft |
| FR-COR-005 | An item is registrable before any assignment or review exists |
| FR-COR-008 | The configured mandatory set is enforced at save and again at registration |
| FR-WFL-014 / DEC-05 | Optimistic version check: a stale write is refused with 409, never applied |
| FR-SEC-008 | Support staff register without any approval authority — no approval capability exists yet for anyone |
| FR-SEC-010 | SYS_ADMIN is absent from every records route. The administrator cannot read the registry |
| FS02-AC-005 | Last-administrator guard prevents an administrator locking everyone out |

## 4. Verification status

Executed against PostgreSQL 16, Node 20 and Chromium.

**Built:** backend `tsc --noEmit` clean; frontend production build clean. Migration `Records1758300000000` applied clean on top of the existing schema.

**API checks — all passed**

| Check | Result |
|---|---|
| Assistant creates a draft | DRAFT, no reference, no registration time, version 1 |
| Draft with empty subject | 400, refused |
| Client supplies its own `registrationIdentity` and `registeredAt` | 400, both fields rejected as undeclared |
| Registration | identity assigned, `registeredAt` = server now, document date unchanged |
| Register the same item twice | 400 |
| Edit a registered record through the draft route | 400 |
| Administrator reads the registry | 403 |
| No session | 401 |

**Integrity checks by direct SQL, using the application's own credentials**

| Attempt | Result |
|---|---|
| Change `registration_identity` on a registered row | `ERROR: registration_identity cannot be changed once assigned` |
| Back-date `registered_at` | `ERROR: registered_at cannot be changed once assigned` |
| Return a registered row to draft | `ERROR: a registered item cannot be returned to draft` |
| Insert a row with state REGISTERED and no identity | check constraint violation |
| Insert a DRAFT row carrying an identity | check constraint violation |
| Insert a second row with an existing identity | unique index violation |

The registered record was then re-read and found unchanged. Unlike the audit table's silent rules, these raise errors: an edit attempting to move a registration timestamp should fail loudly.

**DEC-05 concurrency, executed with two real sessions**

Two assistants both read version 1 of one draft. The first write succeeded and the version became 2. The second write was refused with 409 and the message to reload. The first writer's content survived intact — no silent overwrite. Registering with a stale version was refused the same way.

**Last-administrator guard**

The sole administrator was refused both when revoking their own SYS_ADMIN role and when disabling their own account, with a message naming the remedy.

**Browser checks**

Draft creation and registration driven end to end. A draft renders as `Draft — not official` with a dash for its reference; a registered item renders as `Official record` with its reference and server time. The administrator account sees no Correspondence section at all. Two UI defects were found during this check and fixed before packaging: an identity-screen footnote that had become factually wrong, and a wide table that scrolled the whole page sideways.

## 5. Not verified, and open items

1. **Still no automated test suite.** Three versions of hand-executed checks now sit behind this build, and the regression surface is wide. This is the point at which I would stop adding features for one slice and write the suite — my recommendation for V0.1.4, before dossiers.
2. **No record-level permission evaluation.** Every holder of a registering role sees the whole registry. That is correct for this scope but means FR-SEC-003, FR-SEC-005 and FR-SEC-006 remain unaddressed, and the tester guide says so explicitly at step 15 so broad visibility is not reported as a defect.
3. **No document or file upload.** FR-COR-006 (content and provenance preservation) is untouched. The item currently has metadata only.
4. **Draft editing has no interface.** The API supports it with the version check, and the concurrency behaviour was verified through the API, but the screen offers only create and register. A tester cannot exercise draft editing through the UI.
5. **The date input shows the browser's locale format** (mm/dd/yyyy on a US-locale machine). Cosmetic, but confusing for Dutch-speaking users; worth a fixed display format later.
6. **Audit write failure still does not fail the action.** Now that registration exists, this matters more than it did in V0.1.2: an unaudited registration is a real gap. Recommended to change when review and approval arrive.
7. **HTTPS still not exercised.** Unchanged.

## 6. Slice size

Approximately **712 lines** of new code — backend around 530, frontend around 180, excluding configuration. Slightly over the 700 band, within the stated exception for finishing a function coherently: the registration transaction, the protection trigger and the screen that makes registration testable are one unit.

## 7. Delivery contents

| Item | Path |
|---|---|
| Backend source | `backend/` |
| Frontend source | `frontend/` |
| Deployment instructions, including the new parameters | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.3.md` |
| Earlier notes, retained | `docs/DELIVERY-NOTE-V0.1.1.md`, `docs/DELIVERY-NOTE-V0.1.2.md` |
| Tester guide, 20 steps, expected outcomes on a hidden tab | `docs/JusPol-EDRMS-V0.1.3-Tester-Guide.xlsx` |

Deploy with `npm run migration:run` again; earlier migrations are recorded and will not re-run.

## 8. Suggested commit message

```
V0.1.3 — correspondence items: draft capture and official registration

Adds Correspondence Item in the three FR-COR-001 directions, with DRAFT and
REGISTERED as distinct states and a check constraint making a half-registered
row impossible.

Registration assigns a server-side identity from a sequence and a
server-authoritative timestamp inside one transaction. Nothing the client sends
can influence either: both fields are rejected as undeclared on input, and a
trigger raises an error on any later attempt to change them or to return a
registered item to draft. Document date is stored separately from registration
time.

Applies the DEC-05 optimistic version check to draft edits and to registration,
so a stale write is refused with 409 rather than silently overwriting.

Registration numbering (DEC-01) and the mandatory metadata set (DEC-08) come
from configuration with neutral defaults; no numbering syntax or policy value
is decided in code.

Also adds the last-administrator guard left open by V0.1.2.

Addresses FR-COR-001 to 005, FR-COR-008, FR-WFL-014, FR-SEC-008, FR-SEC-010.
Re-scoped: dossiers and linking moved to V0.1.4 — see delivery note §1.
```

## 9. Next step — a recommendation, not an assumption

I would make V0.1.4 the **automated test suite**, not dossiers: the twenty-odd integrity controls now in place are all verified by hand, and from here every new slice risks a silent regression in one of them. Roughly 450–600 lines, no new product behaviour, and it converts this delivery note's check tables into something that re-runs on every change.

Dossiers, linking and record-level permission evaluation would then be V0.1.5, and that is where FR-SEC-003 and security-before-display become properly testable.

If you would rather keep feature momentum, say so and dossiers become V0.1.4 instead — but the suite gets harder to retrofit with every version.
