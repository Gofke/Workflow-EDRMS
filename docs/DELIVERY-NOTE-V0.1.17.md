# JusPol EDRMS — Delivery Note V0.1.17

**Slice:** PDF text-layer reading (FR-COR-015, continued)
**Gate:** None closes here. Side branch, alongside the Gate 1–3 testing round.
**Builds on:** V0.1.1 to V0.1.16, all protected baseline
**Date:** September 2026

---

## 1. Scope

V0.1.16 read images only, and said to expect this: most ministry correspondence arrives as PDF. When `OCR_ENABLED=true`, a captured PDF is now read too — by a text-layer reader (`pdftotext`, default), not by OCR.

Two different jobs, deliberately two readers:

| Input | Reader | Why |
|---|---|---|
| Image (jpeg, png, tiff) | OCR engine | The words are pixels; they must be recognised. |
| PDF | Text-layer reader | If the words are in the file, take them exactly. Recognising them would introduce errors where none exist. |

A PDF that is only a scanned page carries no text layer. It reads as **EMPTY** — read, nothing found — not as a failure, and the screen says the file is probably a scan and that reading the page image inside a PDF is not built. Nothing went wrong; there was nothing to read.

Not in this version: **rasterising a scanned PDF and running OCR over the pages.** That is the other half, and it is a bigger slice — page extraction, a page limit, and a much slower operation. It should follow once the pilot shows how many PDFs are scan-only.

## 2. Verification status

**Suite: 185 integration tests (fourteen spec files) and 37 component tests**, all passing on a schema rebuilt from empty. 3 integration and 1 component test are new, plus a second stub reader (`backend/test/fixtures/fake-pdftext.sh`).

**Live run with real poppler**, against a migrated and seeded database with `OCR_ENABLED=true`:

| Input | Result |
|---|---|
| A PDF with a real text layer | EXTRACTED, "Ministerie van Justitie en Politie / Besluit 2026-118", engine `pdftotext`; retrieved bytes hashed identically to the file that went in |
| A genuine image-only PDF (a scan saved as PDF) | EMPTY — the case that matters for the Ministry |
| A malformed file claiming to be a PDF | FAILED, and the capture was unaffected |

The first attempt at the scanned case used a hand-written stub file that was not a valid PDF at all, and reported FAILED. That was the test being wrong, not the code: a real image-only PDF was generated and gives EMPTY. Recorded because the distinction is the point of this slice.

**Mutation testing — three properties, all caught**

| Mutation | Result |
|---|---|
| PDFs sent to the OCR engine instead of the text reader | `✕ reads the text layer of a PDF with the PDF reader…`, plus two |
| PDFs skipped as before | same three |
| An empty text layer treated as a failure | `✕ reports a scanned PDF with no text layer as read-and-empty, not as failed` |

**One existing test changed, intentionally.** `skips a type the engine is not asked to read` used a PDF as its example of an unread type. PDFs are now read, so the test uses a Word document instead and keeps its assertion.

## 3. Not verified, and open items

1. **Scanned PDFs still yield no text** (see §1). Expect this to be the common case for paper intake.
2. **`poppler-utils` must be installed** on the server when OCR is on, alongside the OCR engine.
3. **No Dutch language data** for the OCR engine — unchanged from V0.1.16, and not relevant to the text-layer reader, which has no language setting.
4. **No permission filtering** on read text, pre-Gate 4.
5. **No browser walk-through.**

## 4. Slice size

Approximately **260 lines** — backend 90, frontend 10, tests 160.

## 5. Suggested commit message

```
V0.1.17 — PDF text-layer reading, under the same switch

A captured PDF is read by a text-layer reader rather than by OCR: if the words
are in the file, take them exactly. A scan-only PDF has no text layer and reads
as empty, not as a failure, and the screen says so. Verified live against
poppler with a text-layer PDF, an image-only PDF and a malformed file.
```
