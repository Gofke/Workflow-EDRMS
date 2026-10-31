# Projects — demo content and questions for the assistant (V0.5.0)

This guide is for whoever demonstrates or tests the projects module. It covers what the demo data contains, who to sign in as, and which questions to ask the assistant per role, with the answer the system must give. Load the data on a test or staging server with `sudo bash install.sh demo --env staging --reset`; the demo refuses to run on production.

All demo accounts use the password you typed when loading the demo. Sign-in names are `<name>@juspol.test` in development; on staging the domain is the one shown in **Beheer → Accounts**.

## Can this be handled in the workflow?

Yes. Every step in Kiran's notes is now a step in the system, with its own permission check and audit entry:

| Kiran's step | How the system handles it |
|---|---|
| A project has an owner, a project manager and stakeholders | Each project has one **opdrachtgever** (owner), one **projectleider** (project manager), any number of **belanghebbenden** (stakeholders) and **teamleden** (members). Owner and project manager are always two different people. |
| Phase 1 is the business case | Every project starts in the *Business case* phase. Only the project manager writes it: problem, solution, benefits, costs, risks and budget. Every save is in the audit log. |
| The owner approves the business case | The project manager submits it. The owner approves it or sends it back with a reason. Only the owner can decide. |
| Then milestone 1 closes and milestone 2 (documentation) starts | When the owner approves, phase 1 closes automatically, the project becomes *running*, and phase 2 (*Documentatie en ontwerp*) opens. |
| 3–4 milestones per project, 4–5 tickets per milestone | The standard template has four phases: business case, documentation and design, execution, and closure and handover. A project can have 3 to 8 phases. Each ticket belongs to a phase and has an assignee, a start date and a due date. |
| Each task is assigned to someone, for the Gantt chart | The *Planning* tab shows phases and tickets on a time line. Late tickets are red. You can filter to show only what is late. |
| The project ends | The project manager closes each phase once its tickets are done. The owner signs off the last phase, which completes the project. |
| Hold, resume or cancel | Only the owner can do this, and must give a reason. |

## What is in the demo

- **100 accounts** with invented Surinamese names. They include the minister, directors, deputy directors, heads of department, staff, 2 internal auditors and 6 external contractors (unit *Externe leveranciers*).
- **12 projects** covering every stage of the lifecycle:

| Number | Project | Stage | Owner | Project manager | Shows |
|---|---|---|---|---|---|
| PRJ-2026-001 | Renovatie cellenblok C, Santo Boma | Completed | onderdirecteur | sabajo | The full lifecycle, signed off by the owner |
| PRJ-2026-002 | Digitalisering strafregister | Running, phase 3 of 4 | directeur | kartodikromo | Contractors on the team who see only their own tickets |
| PRJ-2026-003 | Camerabewaking binnenstad Paramaribo | Running, **behind schedule** | onderdirecteur3 | sastrodimedjo | Late phase, 7 tickets overdue |
| PRJ-2026-004 | Uitwijkcentrum ICT | Running, **confidential** | directeur2 | marhe | Visible only to the people on it |
| PRJ-2026-005 | Slachtofferhulploket Nickerie | On hold | directeur | wongsodikromo | Paused by the owner, with a reason |
| PRJ-2026-006 | Begrotingscyclus 2027 digitaal | Running, behind schedule | onderdirecteur2 | ramdin | — |
| PRJ-2026-007 | Invoering e-dossier Vreemdelingenzaken | Running | dualrole | chin | — |
| PRJ-2026-008 | Bewustwordingscampagne huiselijk geweld | Running | directeur | karsoredjo | A short project with 3 phases |
| PRJ-2026-009 | Implementatie herziening Wetboek van Strafvordering | Running | minister | dualrole | The minister as owner |
| PRJ-2026-010 | Personeelsdossiers 2010–2020 digitaliseren | Business case **returned** | onderdirecteur2 | vlijter | The owner's reason for returning it |
| PRJ-2026-011 | Vervanging portofoons Korps Politie | Business case **awaiting approval** | directeur2 | pengel | Approve or return it live in the demo |
| PRJ-2026-012 | Opleidingsprogramma wijkagenten 2027 | Business case draft | onderdirecteur3 | asoiti | The project manager still writing |

## Who sees what

Access is need-to-know. The server decides it for the screens, the reports and the assistant alike. The assistant never has more rights than the person asking.

| Who | Access | What they see |
|---|---|---|
| Owner and project manager | Full | Everything, including every ticket |
| Stakeholder | Overview | Business case, phases, team and history; no ticket contents |
| Line of command (minister; directors and heads over the project's unit) | Summary | Status, phase, progress and dates; no business case text, no tickets |
| Team member, including external contractors | Member | Their own tickets only |
| Anyone on a **confidential** project | As above | The line of command does not see it at all unless they are on it |

The same rules hold outside the project screens:

- An overdue ticket is escalated to the project manager and then the owner, not to the assignee's superiors.
- A stand-in does not get copies of project or ticket notifications.
- A ticket is never linked to a matter or a letter, so it never appears on a matter's timeline.
- Ministry-wide figures leave out the tickets of confidential projects.
- When a project manager is replaced, the tickets go to the new one and the old one loses access.

## Questions to ask the assistant, by role

Ask in Dutch or English. Each row lists the question, the account to use, and what the system must do. Rows marked **R** test a refusal or a restriction: these must be right every time, because a single leak fails the release.

| # | Sign in as | Question | Must happen | |
|---|---|---|---|:-:|
| P-01 | minister | Welke projecten lopen achter? | Lists the projects behind schedule or with overdue tickets; PRJ-2026-003 and -006 flagged as behind; no confidential project in the list | |
| P-02 | minister | Hoe staat het project Uitwijkcentrum ervoor? | "Not found": the minister is not on the confidential project | R |
| P-03 | minister | Hoe staat het project Camerabewaking ervoor? | Summary only (the minister has no role on it): phase, progress and the number of overdue tickets, **no ticket list** | R |
| P-04 | directeur2 | Welke business cases wachten op mijn goedkeuring? | PRJ-2026-011, with a link to the project | |
| P-05 | directeur2 | Wat staat er vandaag voor mij klaar? | Includes "1 project awaits your decision as owner" | |
| P-06 | directeur2 | Hoe staat het project Uitwijkcentrum ervoor? | He is the owner, so he sees it in a card. The answer says it is confidential and gives no details: the model was never sent its data | R |
| P-07 | kartodikromo | Hoe staat het strafregister-project ervoor? | Every phase with tickets done, and all tickets, with who is late | |
| P-08 | lam (contractor) | Hoe staat mijn project ervoor? | Only PRJ-2026-002 | |
| P-09 | lam (contractor) | Hoe staat het strafregister-project ervoor? | "You see only your own tickets"; only lam's own late ticket is named | R |
| P-10 | lam (contractor) | Hoe staat het project Uitwijkcentrum ervoor? | "Not found" | R |
| P-11 | dualrole | Hoe staan de projecten in mijn onderdirectoraat ervoor? | The projects in Juridische Zaken and Vreemdelingenzaken, plus those where dualrole has a role | |
| P-12 | onderdirecteur2 | Waarom is de business case van de personeelsdossiers teruggestuurd? | Under the default "metadata" setting the model does not get the reason text, so it cannot quote it; the card links to the project, where the *Business case* tab shows it. Under "records" it quotes the reason | R |
| P-13 | sysadmin | Welke projecten lopen er? | The assistant has no project tools for the system administrator; it says so | R |
| P-14 | directeur | Which projects am I the owner of? | PRJ-2026-002, -005 and -008, answered in English | |

## What is sent to the AI provider

- **Under the default "metadata" setting:** project numbers, statuses, phases, dates, progress percentages, counts, unit names and the names of the people who answer for the work.
- **Never under "metadata":** project names, ticket titles or business case text. The person still sees these, but only in the cards, which come straight from the server.
- **Never at all:** anything from a confidential project. If the person may see it, they get a card and a note saying the details were kept from the model.

These rules are tested in `backend/test/p5-project-assistant.spec.ts`. The tests use a scripted model; no real AI and no key are involved.

## Screens to show in a demo

1. **Projecten**, signed in as the minister: the figures, the list and the time line.
2. **PRJ-2026-002 → Planning**, signed in as directeur: the Gantt chart with phases and tickets.
3. The same project, signed in as lam: only lam's own tickets.
4. **Mijn werk**, signed in as directeur2: "Projects waiting for you as owner". Open PRJ-2026-011 and approve the business case. Phase 1 closes, phase 2 opens, and the project manager gets a notification.
5. **PRJ-2026-010 → Business case**, signed in as vlijter: the reason it was returned, then edit and submit again.
