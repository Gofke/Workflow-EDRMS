# JusPol EDRMS — Delivery Note V0.1.8

**Slice:** Delegation and acting on behalf (FR-DEL)
**Opens:** Gate 3 — Authority and workflow
**Builds on:** V0.1.1 to V0.1.7, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered:

- Explicit, scoped, time-bounded delegation. No credential is shared: the delegate signs in as themselves and the system decides, per action, whether they currently hold authority
- Principal, delegate, permitted actions and validity period all recorded (FR-DEL-002)
- Every action taken under delegated authority records **both** the authenticated actor and the represented authority — in the audit trail and on the authoritative row itself (FR-DEL-003)
- Only the listed actions are granted; nothing else follows (FR-DEL-004)
- Support staff may assign responsibility or set a deadline **only** where a delegation exists (FR-DEL-005)
- Revocation and expiry stop future use without removing evidence of what was legitimately done (FR-DEL-006)
- The delegation register, readable by anyone with a business role, because knowing who is acting for whom is part of knowing who is accountable
- 16 new tests

Not in this version: review and approval (FR-WFL), which is V0.1.9 and closes Gate 3; delegation of registration or document capture; automatic notification of a delegate.

## 2. Authority is re-checked at use, not only at grant

A delegation confers nothing if, at the moment of use, the principal has been disabled or has lost the role that let them delegate. Nobody can lend authority they no longer hold, and a grant made last month should not outlive the authority behind it. This is tested.

## 3. DEC-13 — parameterised

Which roles may delegate, which actions may be delegated, and the maximum duration are all configuration. The defaults are deliberately narrow: the roles that already hold the authority, the two actions the build actually has, and 90 days. A delegation granted in a pilot cannot be un-granted from history later, so the placeholder errs toward less.

## 4. Requirements addressed

| Requirement | How |
|---|---|
| FR-DEL-001 | Delegation is a row, not a shared password. Scope and period are explicit |
| FR-DEL-002 | Principal, delegate, permitted actions, valid from and valid until are all columns |
| FR-DEL-003 | The actor is always the authenticated user; the represented authority travels alongside, never instead. Recorded in `audit_event.represented_authority` and in `on_behalf_of_account_id` on the assignment and due-date rows |
| FR-DEL-004 | Only listed actions resolve. A grant covering one action confers nothing for the other |
| FR-DEL-005 | Support staff are refused without a delegation, permitted with one, and refused again after revocation |
| FR-DEL-006 | Revocation sets `revoked_at`; a trigger refuses to revive it and the row cannot be deleted or rewritten |
| FR-SEC-001 | The delegate acts under their own individual account throughout |
| FR-SEC-010 | The administrator cannot read the delegation register and is excluded from the candidate list |

## 5. Verification status

**Suite: 97 tests, eight spec files, all passing** on a schema rebuilt from empty.

**Mutation testing — five controls, all caught, including both TS-04 invalidating failures**

| Mutation | Result |
|---|---|
| Delegated action attributed to the **principal** instead of the actual actor | `✕ lets a delegate act, recording the actual actor AND the represented authority` |
| Represented authority dropped, delegate credited alone | same test, plus the revocation-evidence test |
| Revocation ignored when resolving authority | `✕ stops future use on revocation without removing what was already done` |
| Validity period ignored | `✕ confers nothing before it starts or after it ends` |
| Scope ignored — any delegation grants any action | `✕ grants only the listed action` |

The first two are precisely the failures TS-04 says would invalidate this domain. Both are caught by the same test, which asserts the actor **is** the assistant, is **not** the Directeur, and that the represented authority names the Directeur.

**Database-level controls, attacked with the application's own credentials:** a delegation cannot be rewritten (`ERROR: a delegation cannot be rewritten`), cannot be deleted (silently discarded, row count unchanged), cannot be revived once revoked, and cannot be granted to oneself (`ck_delegation_distinct`).

**Browser verification, and two design defects found**

1. **The delegate picker drew from the wrong list.** It used the assignable-officials list, which by design excludes support staff — the very people you delegate to. So the feature could not be used for its intended purpose. Added a candidates endpoint: enabled accounts holding a business role, administrator excluded, names only.
2. **Delegated authority never reached the interface.** The controls were gated on the user's own roles, so an assistant holding a valid delegation saw nothing. Added a current-authority endpoint and gated each control on the specific action.

Verified after both fixes, with a delegation covering only `SET_DUE_DATE`: the assistant sees a banner naming the principal, sees the due-date control, and does **not** see the assign control. FR-DEL-004 is visible in the interface, not only enforced behind it.

Also fixed: the login screen still displayed "Version 0.1.1" and the identity screen "0.1.5". Both hardcoded, both stale. Now one constant.

**Recorded honestly:** several browser runs failed on Playwright timing before these checks succeeded — a selection made while a fetch was in flight. Two of those failures looked like product defects and were not; one was. I stopped scripting the grant through the interface and granted it through the API, which is separately test-covered, then verified in the browser only what this slice changed.

## 6. Not verified, and open items

1. **No review or approval yet.** Gate 3 does not close until V0.1.9. A tester cannot yet exercise a full approval round, which is what delegation exists to support.
2. **Delegation covers two actions only.** Registration, document capture and dossier linking cannot be delegated, because support staff can already do them in their own right. Nothing is lost, but the vocabulary will need extending when approval actions arrive.
3. **No notification.** A delegate is not told they have been given authority; they discover it on the screen. Out of scope, worth stating.
4. **A delegate can act across every matter.** Delegation is not scoped to particular dossiers, because FR-DEL-002 requires action scope and period, not object scope, and record-level scoping belongs to Gate 4 and DEC-02.
5. **No frontend tests.** Both defects in §5 are exactly what a component test catches. Third time this has been true; it is the strongest remaining case for adding a thin layer.
6. **No CI runner.** Unchanged, now protecting 97 tests.
7. **Audit write failure still does not fail the action.** Unchanged, and now spans delegated actions.
8. **HTTPS still not exercised.** Unchanged.

## 7. Slice size

Approximately **780 lines** — backend 430, frontend 150, tests 200. Over the 700 band, and recorded as a deviation.

Reason: the guard, the grant and the register are one authority mechanism. Splitting them would have shipped either a grant nobody can use or an enforcement path with nothing to enforce, and the two UI defects in §5 would have gone undetected until the other half arrived. The two endpoints added mid-slice to fix those defects account for roughly 60 of the excess.

## 8. Delivery contents

| Item | Path |
|---|---|
| Backend, frontend, tests | `backend/`, `frontend/`, `backend/test/` |
| Deployment instructions, including the DEC-13 parameters | `README.md` |
| This note | `docs/DELIVERY-NOTE-V0.1.8.md` |
| Earlier notes and the Gate 2 pack, retained | `docs/` |

No tester pack this version: Gate 3 is tested as a whole once review and approval exist in V0.1.9.

## 9. Suggested commit message

```
V0.1.8 — delegation and acting on behalf

Explicit, scoped, time-bounded delegation with no credential sharing. The
delegate signs in as themselves; the system resolves, per action, whether they
currently hold authority. Authority is re-checked at use, so a grant confers
nothing once the principal is disabled or loses the delegating role.

Every action under delegated authority records both the authenticated actor and
the represented authority — in audit_event.represented_authority and in
on_behalf_of_account_id on the authoritative rows, so state and history cannot
disagree about who acted for whom.

Only listed actions resolve (FR-DEL-004). Revocation stops future use and keeps
the evidence: a trigger refuses to rewrite or revive a delegation and the rows
cannot be deleted.

DEC-13 parameterised with narrow defaults. 16 new tests; all five mutation
checks caught, including both attribution failures TS-04 calls invalidating.

Fixes two design defects found in the browser: the delegate picker excluded
support staff, and delegated authority was not reflected in the interface at
all. Also centralises the build version string, which had gone stale on two
screens.

Addresses FR-DEL-001 to 006, FR-SEC-001, FR-SEC-010.
```

## 10. Next step

**V0.1.9 — submit, review, return for correction, approve (FR-WFL).** One active review step at a time, per the Delivery 1 complexity limit; this is not a workflow engine. A return must record its reason without deleting the review event that preceded it, and an approval must record actor, server time, outcome and — where acting on behalf is permitted — the represented authority, which V0.1.8 now makes possible.

That closes Gate 3. If the review flow proves larger than one slice, it becomes V0.1.9 and V0.1.10, and I will say so rather than overrun the band silently.
