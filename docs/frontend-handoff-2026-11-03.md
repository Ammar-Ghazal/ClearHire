# ClearHire frontend: implementation handoff

Prepared November 3, 2026. Design approved on the canvas at https://claude.ai/artifact/Ap5SS5XaKuxRrDuzWWvsXf (private; share it from its Share menu). No application code was changed. The target is a complete, consistent demo: every page works for a demo identity against the imported demo fixtures.

All people, companies, repositories, dates, salaries and scores on the canvas are **simulated**. Skill names, levels, verdicts, attribution values, analysis states and score formulas are real (`packages/shared`).

## 1. Pages

| Board | Route | Role | Data |
| --- | --- | --- | --- |
| 0 Choose a demo identity | `/` | Both | Demo candidates (non-organization) and demo employers |
| 1 Shell (sidebar) | all pages | Both | Identity, badge counts |
| 2–3 Matches, 5 narrow | `/matches` | Both | Match list for the identity |
| 4 Match detail | `/matches/:candidate/:job` | Both | Match, relationship, evidence, priorities |
| 6–7 Job postings, posting | `/postings`, `/postings/:id` | Employer | Postings, requirements, priority editor |
| 8 Interviews | `/interviews` | Both | Interviews with slots |
| 9–10 Offers, offer | `/offers`, `/offers/:id` | Both | Offers |
| 11–12 Profile | `/profile` | Both | Seeker or employer profile |
| 13 Settings | `/settings` | Both | Identity, GitHub account of the sample profile |

Badges count items waiting on the identity: matches needing a response, interviews needing times (employer) or a pick (seeker), shared offers awaiting the seeker. Below 768px the sidebar becomes a sheet opened from the top bar.

## 2. Rules (enforce on the server; the UI only reflects them)

**Identity.** A demo identity is a sample candidate or employer, chosen on `/`. It is labelled "Demo identity" everywhere and is never presented as GitHub authentication. GitHub sign-in stays as it is for demo operators.

**Relationship stages.** One vocabulary on every page: Needs your response · Waiting for them · Discussion · Interview · Offer shared · Offer accepted · Offer declined · You declined / Declined by {other}. List filters: All, Needs your response, In progress, Completed, Closed.

- Each party answers Yes, Maybe or No. Nothing opens until both have answered.
- Both Yes → Interview. Both answered, no No, at least one Maybe → Discussion.
- In Discussion, both confirming → Interview.
- Yes or Maybe can change to No at any open stage. No is permanent: the match closes, messaging and progress stop, existing discussion stays readable. No reason is asked. Each side sees who declined.
- Discussion is writable in Discussion, Interview and Offer shared; read-only after completion or closure.
- Offer accepted completes the relationship (read-only afterwards). Offer declined closes it.
- Match detail shows the current stage and each party's answer. No dated history.

**Interviews.** One interview per match at the Interview stage. Employer sets format, length and a location or link (entered by hand; no calendar integration or meeting creation) and proposes several slots. Employer can replace slots until one is confirmed. Candidate confirms exactly one slot; it is then fixed. Candidates ask for other times in Discussion.

**Offers.** Employer creates a draft from a match at the Interview stage: role, base salary (CAD/year), start date, work arrangement, note. Drafts are visible only to the employer. Sharing moves the match to Offer shared and freezes the terms. Candidate accepts or declines. If the employer changes to No while an offer is shared, the match closes as declined by the employer and the offer becomes Offer withdrawn.

**Priorities.** Per posting, 0–3 (0 = ignored). Change one, reset one to suggested, or Reset all priorities. Every change applies to the posting and refreshes its matches with server-calculated scores. Editing needs a current posting analysis (existing 409 `job_not_current`). Seekers see priorities read-only.

**Scores.** Only from current analyses; never shown as 0%. Labels: Analysis updating (run pending, the only use of this wording) · Analysis failed · Analysis outdated · Not analyzed yet · No attributed code. Provisional is shown when the server says so. Skill levels are candidate-wide; repository cards list supported skills without levels. Attribution wording: "Recorded only under @login" (sole), "Recorded under several accounts" (shared), "Provisional: landing not confirmed", plus "AI co-author declared".

**Profiles.** Seeker: desired titles, locations and work arrangement are editable and do not affect scores. Resume, GitHub, selected repositories and demonstrated skills come from the sample profile, read-only. Employer: company details read-only from the sample company. Postings are imported and not edited.

## 3. Reuse as is

- `GET /demo/candidates`, `GET /demo/candidates/:key`: identity picker, seeker profile (resume, GitHub verification, repository breakdown, freshness).
- `GET /demo/jobs`, `GET /demo/jobs/:id`: postings list and detail, requirements with `priority`, `prioritySource`, `suggestedPriority`, `referenceStatus`.
- `GET /demo/match?candidate&job`: match detail scores, requirements, evidence (`DemoMatchSchema`).
- `PUT /demo/jobs/:id/priorities/:skillId` (`null` resets one): priority editor, once its authorization is widened (below).
- `matching.ts`, `repository-breakdown.ts`, freshness and run states: unchanged.
- The current `DemoScreen` remains the operator tool for starting analyses; move it to its own route.

## 4. Backend additions (needed for the approved pages)

1. **Demo identity session.** `POST /demo/identity` `{ kind: 'candidate' | 'employer', key }`, `DELETE /demo/identity`, `GET /demo/identity` (identity plus badge counts). Separate httpOnly cookie from `ch_sid`. All routes below act as this identity and return 401 without it.
2. **Employer location.** Add `location` to `demo_employers` and the importer fixture.
3. **Priority authorization.** Allow the employer identity that owns the job to call the priority route (today operator-only), and add `DELETE /demo/jobs/:id/priorities` to reset all overrides in one transaction.
4. **Match list.** `GET /demo/matches` for the identity: every non-organization candidate × in-scope posting pair, with no minimum compatibility (unscored pairs show their reason), each with job/candidate summary, `DemoMatch` availability or scores, the non-current side's freshness state, relationship stage and `lastActivityAt`. A `job` filter for the employer's posting selector. Sorting by compatibility, coverage or activity can be done on the client.
5. **Relationships.** Table keyed by (candidate key, job id): each side's answer, each side's interview confirmation, timestamps. `PUT /demo/matches/:candidate/:job/answer` `{ answer }` (only unset → any, Yes/Maybe → No) and `POST …/confirm-interview`. A shared `relationshipStage()` derives the stage from relationship + offer, and every write checks it.
6. **Discussion.** Messages table (relationship, author side, body, created). `GET` / `POST …/messages`; POST rejected (409) outside Discussion, Interview, Offer shared.
7. **Interviews.** Interview (relationship, format, length, location/link, confirmed slot) and slots (interview, starts at). `GET /demo/interviews`; employer `PUT …/interview` (details + replace slots, only before confirmation); candidate `POST …/interview/confirm` `{ slotId }`.
8. **Offers.** Offer (relationship unique; role, base salary, start date, arrangement, note; status draft | shared | accepted | declined | withdrawn). `GET /demo/offers`, `GET /demo/offers/:id`; employer `PUT` draft and `POST …/share`; candidate `POST …/accept` / `…/decline`. The employer's change to No sets a shared offer to withdrawn in the same transaction.
9. **Seeker preferences.** Table per candidate key (titles, locations, arrangements). `GET` / `PUT /demo/profile/preferences`.
10. **Shared schemas** in `packages/shared/src/index.ts` for every request and response above, including `RelationshipStageSchema`, `MatchSummarySchema`, `InterviewSchema`, `OfferSchema`, `DemoIdentitySchema`.

Schema changes go through `pnpm db:generate` and `pnpm db:migrate`. Every write validates with zod `safeParse` and returns `{ error: { code, message } }`.

## 5. Frontend work

- Add a router and install the shadcn/ui Sidebar. Both are new dependencies and need approval before installing.
- Build the boards above with Tailwind and the slate palette. Parse every response with the shared schemas through `src/api.ts` (`credentials: 'include'`).
- One status map (stage → label, chip style, filter group) and one score-state map, shared by lists, detail, interviews and offers.
- After a priority change or reset, refetch the posting and its matches. Never recompute scores on the client.

## 6. Future features (not in this build)

- **Match history timeline.** A dated record of answers, stage changes, interview and offer events on match detail. Removed from this design; add it and refine its content later.
