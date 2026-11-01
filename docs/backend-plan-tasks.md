# Scope and implementation discipline

- /plan Study ClearHire's current code and repository instructions before proposing changes. Preserve the existing Fastify, TypeScript, Drizzle/Postgres, React and shared Zod stack. Follow sections 0–9 below in order. For each task, identify the smallest necessary changes, justify every new dependency, table, endpoint and abstraction, and specify acceptance checks. Reuse existing code; defer stretch features and speculative infrastructure. Do not implement yet.

## 0 — Configuration

- /plan Inspect `apps/api/src/env.ts` and plan the minimum configuration changes for GitHub App authentication, Meta Muse Spark, Modal and Google OAuth. Keep credentials server-side and follow the repository restrictions on environment files. Verify current provider interfaces before choosing SDKs; prefer existing libraries or native fetch. Specify small connection checks, without exposing secrets. Do not implement yet.

## 1 — Foundations

- /plan Design the minimum shared Zod contracts and Drizzle migrations needed for accounts, jobs, selected repositories, immutable source snapshots, contribution evidence, analysis results and matches. Preserve existing users and sessions. Use JSONB for bounded result structures that do not require relational querying; justify separate tables and indexes. Define ownership, deduplication and versioning only where needed for reproducibility or correctness. Do not implement yet.

- /plan Plan ingestion, analysis and matching jobs using pg-boss with the existing Postgres database and API process. Define idempotent execution, bounded retries, progress and complete/partial/failed states. Avoid Redis, separate orchestration services and generic workflow abstractions. Specify recovery from duplicate delivery and interrupted jobs. Do not implement yet.

- /plan Plan one small Muse Spark client using native fetch or a justified compatible SDK, strict JSON-schema responses and Zod validation. Include timeouts, bounded retries, input/output limits, token/cost accounting, a concurrency-safe analysis spending cap and validated-result caching by input/model/prompt version. Use Standard mode; verify model availability and current pricing. Add an offline fake for tests. Do not implement yet.

## 2 — Sign-in and access

- /plan Extend existing sessions for candidate/employer roles, employer password sign-in using argon2id, and Google OAuth with state/PKCE and verified emails. Preserve GitHub sign-in and enforce server-side role checks. Define safe account linking, sign-in rate limits and protection for cookie-authenticated mutations. Defer password recovery and email verification flows. Do not implement yet.

- /plan Extend GitHub access using the existing Octokit client and `@octokit/auth-app` where needed. Support authorized personal and organization installations, repository-scoped read tokens, and checks that both the user and app can access each selected repository. Recheck access before ingestion and source disclosure; do not trust client-supplied installation IDs. Do not implement yet.

## 3 — Employer jobs

- /plan Plan minimal job creation, editing, listing and closing endpoints in Fastify. Use Muse Spark to suggest normalized requirements, levels and weights; require employer review before publication. Validate weights with Zod, version approved requirements and invalidate affected matches. Keep forms within the existing React/Tailwind application. Do not implement yet.

## 4 — Candidate inputs

- /plan Plan candidate profiles, job interests, an authorized GitHub repository checkbox picker, one Analyze action and status polling through `POST /analyses` and `GET /analyses/:id`. Resolve repository IDs server-side and flag forks. Include the original checklist's bounded résumé parsing with `@fastify/multipart`, unpdf and mammoth, storing confirmed text only; defer résumé claim analysis. Do not implement yet.

## 5 — Repository ingestion

- /plan Plan static repository ingestion in Modal using its supported SDK. Pin downloads to a commit SHA; never install dependencies or execute repository scripts, builds or tests. Specify safe extraction, byte/file/time/memory limits, restricted credentials/networking and guaranteed cleanup. Verify whether offline parsing requires a separate stage. Return filtered text and facts through a validated Zod contract. Do not implement yet.

- /plan Design deterministic filtering and source selection that excludes node_modules, vendored/generated code, build outputs, binaries and lockfile bodies. Retain relevant source, tests, migrations, manifests and CI files. Summarize dependencies locally, screen out secrets, preserve original line ranges and record omissions. Start with bounded line chunks; justify syntax parsers only where they materially improve evidence selection. Do not implement yet.

- /plan Plan bounded commit and PR collection with Octokit, retaining changed hunks, parent SHAs, stable account IDs, author/committer distinctions and coauthors. Attribute cited lines using change mapping and targeted blame where necessary. Handle truncated patches, squash merges and shared changes conservatively. Preserve unknown attribution and history coverage; never award whole-file ownership from commit counts or infer human authorship from Claude Code markers. Do not implement yet.

## 6 — Technical analysis and skills

- /plan Design compact evidence packets around a feature's implementation, relevant callers/data model, error handling, tests and candidate changes. Use deterministic selection and bounded context expansion before Muse Spark calls. Preserve source IDs and exact ranges through summaries; reuse cached results. Avoid embeddings, vector databases and autonomous analysis agents unless a demonstrated retrieval failure justifies them. Do not implement yet.

- /plan Define a small skill taxonomy and evidence rubric for used, solid and advanced. Separate repository functionality, attributed contributions and execution quality. Plan structured Muse Spark output with source references, followed by deterministic range/quote/attribution validation and bounded semantic verification. Treat repository text as untrusted input and give the model no execution tools. Report uncertainty and unavailable assessments; do not treat dependencies as proficiency, static tests as passing, or AI-assisted contributions as proof of independent mastery. Do not implement yet.

## 7 — Matching

- /plan Plan requirement matching from validated attributed evidence using normalized skill lookup and Postgres text search only where needed. Use Muse Spark for unresolved semantic comparisons. Calculate weighted met/partly-met/not-shown scores in TypeScript, retain the full denominator and distinguish unavailable evaluation from missing evidence. Keep partial results provisional and reuse analysis rather than resending repositories. Do not implement yet.

## 8 — Minimal results UI

- /plan Plan one expandable technical breakdown beneath each selected repository in the existing React/Tailwind UI. Show purpose, technical techniques, supported quality observations, attributed contributions, skill levels and exact code links, plus partial/error states. Read persisted results through an authorized endpoint; opening a panel must not trigger model calls. Add only the original checklist's essential match views and permitted employer evidence access. Do not add dashboards, charts, chat, AI-detection badges or unrelated navigation. Do not implement yet.

## 9 — Verification

- /plan Plan focused Vitest fixtures for fabricated quotes, two authors in one file, shared/squashed changes, untouched forks, truncated history, archive attacks, denied access, provider failure, spending caps and duplicate jobs. Check matching denominators and incomplete evaluations. Use the Meta fake for routine tests; create a small human-reviewed evidence set to assess claim accuracy, attribution and abstention. Finish with one employer/job/candidate/public-repo demo, repository typechecks/tests and measured Meta/Modal cost. Avoid tests that merely mirror implementation. Do not implement yet.
