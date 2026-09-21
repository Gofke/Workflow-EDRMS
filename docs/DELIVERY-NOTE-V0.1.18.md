# JusPol EDRMS — Delivery Note V0.1.18

**Slice:** Consolidation — cumulative verification and a tester pack for V0.1.13 to V0.1.17
**Gate:** None. This closes the side branch and makes it testable.
**Builds on:** V0.1.1 to V0.1.17, all protected baseline
**Date:** September 2026

---

## 1. Why this version exists

Five slices were built on a side branch while the Gate 1–3 testing round was being arranged: dossier closure, timeline paging, CSV export, the duplicate warning, and text reading for images and PDFs. Each was verified on its own. This version verifies them together and gives testers something to work from, because until now no tester pack covered any of them.

**No new behaviour. No code changed except the build version.**

## 2. Cumulative verification

Run on a database dropped and recreated empty:

| Check | Result |
|---|---|
| All twelve migrations from an empty schema | 12 executed, no errors |
| Seed | 9 accounts created |
| Integration suite | 185 of 185, fourteen spec files |
| Component suite | 37 of 37, four files |
| Backend production build | compiles |
| Frontend production build | compiles |

Everything V0.1.11 established still holds: the schema is reachable from nothing by migration alone, and no test depends on a database left over from an earlier run.

## 3. The tester pack

`docs/JusPol-EDRMS-V0.1.18-Consolidated-Tester-Pack.xlsx`, in the same shape as the Gate 2 and Gate 3 packs: Instructions, Test Steps, Accounts, "Not in this pack", and a hidden Evaluation tab for reviewers with the expected outcome, the requirement and an escalation trigger for every step.

26 steps in one continuous journey — a matter taken to finalised, closed, probed while closed, reopened, then a near-duplicate registered:

| Steps | What they prove |
|---|---|
| 1–7 | A matter reaches finalised, and only a decision-maker can close it |
| 8–11 | A closed dossier reads but does not change, through every route a tester can reach |
| 12–14 | Reopening needs a reason, preserves the closure, and restores ordinary work |
| 15–16 | The history reads in order, nothing repeated, and paging loads more rather than the same again |
| 17–20 | Export matches the screen, carries its provenance, and a reason beginning with `=` stays text in Excel rather than becoming a calculation |
| 21 | The administrator still cannot reach record content |
| 22–23 | The duplicate warning names the record, does not block, and registering creates a separate record |
| 24–26 | Text reading, if it has been switched on: an image, a scanned PDF (expected to read as empty), and a typed PDF |

Steps 24–26 are marked BLOCKED unless OCR has been enabled on the test server, so the pack runs either way.

Step 19 is worth pointing out to whoever runs the round: it asks the tester to open the downloaded file in Excel and copy out a cell verbatim. That is the CSV-injection check, and it only works if it is done in a spreadsheet rather than a text editor.

## 4. The open items, consolidated

Carried forward from the five notes, and unchanged by this version.

**Blocked on the Ministry**

1. **DEC-02 — sensitivity and need-to-know.** Still the only decision blocking work. Gate 4 waits on it, search waits on Gate 4.
2. Permission filtering is absent in three new places: the timeline, **the CSV export** and the duplicate warning. The export matters most, because it leaves the system. All three must go through the FR-SEC-003 evaluator when it exists.
3. Close/reopen authority is a placeholder (`DOSSIER_CLOSURE_ROLES`).
4. Virus scanning on uploads.

**Waiting on the testing round**

5. Three overlapping history views. The timeline subsumes the other two, and consolidating them now would invalidate the Gate 2 and Gate 3 packs, which name the old labels.

**Known gaps in what was built**

6. A scanned PDF yields no text. Rasterising its pages and running OCR over them is not built, and paper intake is exactly where it would matter.
7. No Dutch language data for OCR (`tesseract-ocr-nld`), and no accuracy measurement on real scans.
8. No PDF export of a timeline; CSV only.
9. OCR runs inside the capture request after the capture commits. Acceptable at pilot volume; a queue is the answer if it is not.

**Engineering**

10. No CI runner. Still the cheapest remaining improvement, and it needs repository access.
11. HTTPS never exercised.
12. Backup covering `DOCUMENT_STORAGE_PATH` and the database together, never rehearsed.

**Not verified anywhere**

13. **No browser walk-through of any of the five slices.** Automated tests and API-level live runs only. That is precisely what the tester pack is for.

## 5. Suggested commit message

```
V0.1.18 — consolidation of V0.1.13 to V0.1.17

No behaviour change. Cumulative verification on a schema rebuilt from empty:
twelve migrations, 185 integration tests, 37 component tests, both production
builds. Adds a 26-step consolidated tester pack covering closure, paging,
export, duplicates and text reading, with a hidden evaluation tab, and
consolidates the open items from five delivery notes into one list.
```
