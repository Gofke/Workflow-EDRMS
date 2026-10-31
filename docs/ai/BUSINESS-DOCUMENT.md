# AI assistant (Gemini) — business document

| | |
|---|---|
| Product | JusPol EDRMS V0.4.0 — the assistant panel |
| Client | Ministerie van Justitie en Politie, Suriname |
| Owner | Gofke (project), Kiran Wasim (project manager) |
| Date | 31 October 2026 |
| Status | Draft for approval — decisions marked **[decide]** are defaults the ministry can change in settings |

## 1. Problem

Officials ask colleagues and managers by phone where a letter or matter stands, who handles it, what is late
and what waits for them. Managers want figures for their directorate or department without building a
report. The screens hold all of this, but finding it takes many clicks.

## 2. What the assistant is

A chat panel on every page — like ChatGPT — where a person types any question in Dutch or English. It
answers from the ministry's live data through read-only tools, explains how the system works, and helps with
ordinary office work (wording a sentence, explaining a term). It runs on the ministry's server; the model
behind it is Google Gemini on the free tier, behind one adapter so a paid or self-hosted model can be
switched in by settings only.

## 3. Users and roles — the line of command

The assistant acts on behalf of the person asking and never sees more than that person may. On top of the
record permissions (confidentiality levels, need-to-know), it answers **within the person's line**:

| Who | Line the assistant answers about |
|---|---|
| Minister | The whole ministry |
| Directeur | Their directorate and everything under it |
| Onder-Directeur | Their sub-directorate and its departments |
| Head of department | Their department |
| Employee | Their own work and their department |
| Records manager | Archive and retention across the ministry |
| Auditor | How the system works, audit and integrity figures — no record content |
| System administrator | How the system works, accounts and settings — no record content |

Matters and letters a person is directly involved in (created, responsible, task, advice, review, granted
access) are always in their line.

## 4. In scope

- Status of a matter, letter or task by number; who handles it; deadline and working days left or late.
- Lists and counts within the line: open, overdue, due this week, per department, per person, per month.
- "What is waiting for me", deadline risk, open advice requests, approvals waiting.
- Who heads which unit; which people work in my line.
- How-to answers from the help articles; where to click.
- General office help (wording, explaining a term, a short draft text) — **[decide]** scope can be narrowed to
  ministry work only (`scope = work`).

## 5. Out of scope — it must never

- Change, register, approve, send or delete anything (a later version may *propose* actions with a confirm button).
- Give legal or medical decisions; decide on cases.
- Reveal confidential or secret records to anyone who may not see them, or send them to an outside model.

## 6. Languages

Answers in the language of the question (Dutch or English); dates in Suriname time, dd-mm-yyyy.

## 7. Data that may reach Gemini (free tier)

Google's terms for unpaid services say content may be used to improve Google's products, may be read by
human reviewers, and that sensitive, confidential or personal information must not be submitted. So, with
the free tier:

| Data | To Gemini? |
|---|---|
| Help texts, unit names, category names, statuses, dates, deadlines, counts, registration numbers | yes |
| Names and job titles of ministry officials (who handles what) | yes |
| Letter and matter subjects, sender names, document text, comments | **no** — shown to the user in the panel by the system itself, never sent to the model |
| Confidential and secret records (any field beyond "there is a confidential matter") | **never** |
| ID numbers, phone numbers, e-mail addresses typed into a question | removed before the question is sent |

With a paid Gemini tier or a self-hosted model the ministry may allow subjects of open/internal records
(`dataPolicy = records`) **[decide]**. Confidential and secret content never leaves the ministry network.

## 8. Channels

The "Vraag de assistent" panel on every page (desktop and phone), and the Assistent page.

## 9. Model and budget

Free tier first: `gemini-flash-latest`, falling back to `gemini-flash-lite-latest` when the free limit is
reached. Paid tier only after the ministry approves budget and data terms. No cost on the free tier.

## 10. Limits

30 questions per person per hour; 60 requests per minute per address; questions up to 2,000 characters;
up to 30 turns of history; at most 6 tool rounds and 80 seconds per question.

## 11. Success measures

≥ 90 % correct on the evaluation set; 100 % correct refusals on privacy and other-role questions; counts equal
to the screens.

## 12. Risks and mitigation

| Risk | Mitigation |
|---|---|
| Wrong answer | Tools give exact data; the prompt forbids invention; evaluation set before each release |
| Data leak to Google | Metadata-only tools; leak tests with planted text; confidential never sent |
| Seeing another directorate's work | Line scope enforced in the database query of every tool, tested per role |
| Prompt injection | Rules in code, not in the prompt; record text never reaches the model |
| Free limit reached | Fallback model, then the built-in offline assistant with a clear message |

## 13. Privacy and legal

Free-tier terms as above (checked 31 October 2026, Gemini API Additional Terms, last updated 28 April 2026).
Questions are kept in the person's own chat history (only they can read it); the audit log records who asked,
when, which tools ran and the result — not the question text.

## 14. Approvals

The ministry approves scope (section 4), the data policy (section 7) and the model choice (section 9).
Gofke approves releases.

## 15. Timeline

V0.4.0 on staging with the tester round; production after the tester sheet and audit scenarios pass.
