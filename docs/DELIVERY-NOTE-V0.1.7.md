# JusPol EDRMS — Delivery Note V0.1.7

**Slice:** Document capture, integrity and retrieval (FR-COR-006, FR-COR-014)
**Closes:** Gate 2 — Registration and filing
**Builds on:** V0.1.1 to V0.1.6, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered:

- Capture of a document against a correspondence item, on a draft or a registered record
- Content-addressed storage: bytes written under their own SHA-256, so identical content is stored once and no business identity derives from a filename or a path (BR-001)
- The integrity reference FS-06 §6 requires, computed server-side over the received bytes
- Verification on every retrieval. Content that no longer matches its reference is refused, not served
- Provenance: who captured it, server capture time, original filename, size and hash; the sender and registration time come from the item
- Append-only captures. A further document is added alongside; nothing is replaced or deleted
- Retrieval in usable form — the original bytes, with the recorded media type, as an attachment
- Three new audit event types, including a failed integrity check
- 10 new tests

Not in this version: OCR (FR-COR-015), duplicate-document warnings (FR-COR-016), thumbnails or in-browser preview, virus scanning, retention.

## 2. Why append-only rather than versioned

FR-FIN-005's versioning rules are open, and TS-08's correction cases explicitly **record** the build's version behaviour rather than asserting a requirement. So this version stores an ordered history of captures and asserts nothing about which one is "the version". A correction is a new capture; the earlier content stays retrievable, which is what FR-GEN-007 demands. When the versioning rules arrive, a version model can be layered on this history without any captured evidence having been lost in the meantime.

## 3. Requirements addressed

| Requirement | How |
|---|---|
| FR-COR-006 | Captured content preserved byte-for-byte and retrievable in usable form; provenance recorded and displayed |
| FR-COR-014 | Upload and capture of scanned paper correspondence, PDF and image types accepted |
| FR-GEN-007 | No silent overwrite. Append-only in the database; a later capture never replaces an earlier one |
| FS-06 §6 | File association plus integrity reference, verified on use rather than merely stored |
| FR-COR-016 | No silent merge: no unique constraint on content hash, so two records may legitimately carry the same document and remain separate associations |
| BR-001 | The filename is a label. Storage keys are content-derived, and any path in a supplied name is stripped |
| FR-SEC-010 | Content is closed to the system administrator — the most sensitive part of a record, and the clearest case for the rule |

## 4. Verification status

**Suite: 81 tests, seven spec files, all passing**, twice consecutively on a database rebuilt from empty by the migration chain.

The byte-fidelity test is the automated form of TS02-TC-REG-012. That case asks a tester to record a distinctive visible marker before capture and confirm it afterwards; the test embeds a marker in the file's bytes and compares the retrieved bytes exactly, across a fresh sign-in.

**Mutation testing — four controls, all caught**

| Mutation | Result |
|---|---|
| Integrity verification removed from retrieval | `✕ refuses to serve content that no longer matches its integrity reference` |
| Accepted media type check removed | `✕ refuses an unaccepted media type and an empty file` |
| Filename path stripping removed | `✕ strips any path from the supplied filename` |
| Append-only rule dropped from the capture table | `✕ discards edits and deletes against the capture record` |

**A flaw the mutations exposed in my own test.** Three of those four mutations initially failed an extra, unrelated test. The cause was mine: the tamper test corrupts a stored file and restored it *after* its assertion, so when the first mutation made that assertion fail, the restore never ran and damaged content stayed in the content-addressed store. Every later run that hashed to the same key then read corrupted bytes and failed for the wrong reason. The restore now runs in a `finally` block and the store is cleared before each run. Re-run afterwards, each mutation fails exactly its own test and nothing else.

This is worth recording beyond the fix: a content-addressed store survives a database reset, so a test that damages content must repair it unconditionally.

**Browser verification**

Capture, download and survival through registration, driven end to end. The downloaded bytes were compared to the source file and were identical, marker included. After registration the same document is still listed with the same hash and capture time.

Two defects found and fixed during this:

1. The panel was rendered inside the narrow action column, where it clipped its own explanatory text. It now occupies a full-width row beneath the item.
2. A failed document load showed nothing at all — no list, no error. The load now runs through the same error handler as every other action.

One environmental failure is also worth recording so it is not mistaken for a defect later: the first browser run failed with a 500 because PostgreSQL had stopped and my migration run had silently done nothing. **`npm run migration:run` on a stopped database reports no error that a casual reader would notice.** Check the migration output, not just its exit.

## 5. Not verified, and open items

1. **No virus or malware scanning.** Nothing in the frozen baseline requires it, but a pilot that accepts uploads from outside should have it before real correspondence arrives. Worth raising with the Ministry rather than deciding here.
2. **Media type is taken from the upload, not sniffed.** A PDF-declared file containing something else would be stored and served with the declared type. Mitigated by `nosniff`, a restrictive `Content-Security-Policy` and attachment disposition, so a browser will not execute or render it — but the declared type is not proof of content.
3. **No OCR.** FR-COR-015 is untouched. When it arrives, OCR text must be retrieval assistance only and must never replace the captured content.
4. **No storage quota or cleanup.** The store grows indefinitely. Content-addressing deduplicates identical files, and nothing is ever deleted, which is correct for evidence and needs a retention decision eventually.
5. **The storage directory is not covered by database backups.** Stated in the README because it is easy to get wrong: the database holds the integrity reference and the directory holds the evidence. Backing up one without the other leaves verifiable references to content that no longer exists.
6. **No frontend tests.** Both defects in §4 are the kind a component test catches.
7. **No CI runner.** Unchanged.
8. **HTTPS still not exercised.** Unchanged.

## 6. Slice size

Approximately **700 lines** — backend 330, frontend 130, tests 240. At the top of the band.

## 7. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, tests | `backend/`, `frontend/`, `backend/test/` |
| Deployment instructions, including the storage-path warning | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.7.md` |
| Earlier notes, retained | `docs/DELIVERY-NOTE-V0.1.1.md` to `V0.1.6.md` |
| Gate 2 tester pack | `docs/JusPol-EDRMS-Gate-2-Tester-Guide.xlsx` |

## 8. Gate 2 status

This slice closes Gate 2. A tester can now carry out the whole filing task: receive a letter, capture the scan, register it, watch the reference be assigned, file it into a dossier, assign the responsible official, set and then move the deadline with a reason, and read the history back.

The Gate 2 pack in this delivery covers that end-to-end workflow rather than this slice alone. The consolidated build for the gate is this ZIP — the application in full, not a diff.

Reminder of the naming convention for future gate packages: the filename should state which versions the consolidated build contains.

## 9. Suggested commit message

```
V0.1.7 — document capture, integrity and retrieval; closes Gate 2

Captures documents against correspondence items, on drafts and registered
records alike. Bytes are stored content-addressed under their own SHA-256, so
no identity derives from a filename or path and identical content is stored
once. The hash is the integrity reference FS-06 §6 requires and is re-verified
on every retrieval: content that no longer matches is refused rather than
served, and the failed check is itself recorded as an event.

Captures are append-only. A correction adds a new capture and the earlier
content stays retrievable, which satisfies FR-GEN-007 without inventing the
version model FR-FIN-005 leaves open. No unique constraint on content hash, so
two records carrying the same document remain separate associations rather than
being silently merged (FR-COR-016).

Retrieval returns the original bytes with the recorded media type, as an
attachment, with nosniff and a restrictive CSP.

10 new tests, including the automated form of TS02-TC-REG-012: a marker embedded
in the file's bytes, compared exactly after a fresh sign-in. All four mutation
checks caught. Fixes a test flaw where a failed tamper assertion left damaged
content in the content-addressed store.

Addresses FR-COR-006, FR-COR-014, FR-GEN-007, FR-COR-016, FR-SEC-010.
```

## 10. Next step

Gate 3 opens with **V0.1.8 — delegation and acting on behalf (FR-DEL)**. FR-DEL-003 is the requirement that matters: an action under delegated authority must record both the authenticated actor and the represented authority. DEC-13, the delegation capability matrix, is open and would be parameterised as the others have been.

Before that, Gate 2 is ready to hand to testers, and so is Gate 1. Two gates' worth of workflow are now sitting finished and untested by anyone but me.
