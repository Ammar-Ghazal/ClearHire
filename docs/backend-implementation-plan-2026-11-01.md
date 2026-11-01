# ClearHire backend review and implementation plan

Prepared November 1, 2026. Investigation and implementation plan only; no application code or configuration was changed. Build sequence follows the supplied to-do list, phases 0–9. Recommendations below refine evidence handling within that sequence.

## 1. Goal and current implementation

ClearHire aims to match candidates to employer requirements using inspectable GitHub evidence. The useful output is a traceable chain: requirement → demonstrated technique → concrete code → attributed contribution → bounded assessment of execution quality. Repository ownership, dependency names and résumé claims alone cannot establish proficiency.

The current repository implements GitHub sign-in, encrypted token storage, sessions, profile/emails, and installation lookup. It does **not** yet extract repositories or evaluate skills:

- `apps/api/src/lib/github.ts:38`: exchange the OAuth code; `:81`: fetch profile, email identities and installation. `:95` selects only the installation on the user's own account, excluding organization installations.
- `apps/api/src/routes/auth.ts`: persist identity/connection and create the session.
- `apps/api/src/db/schema.ts:1`: explicitly a skeleton; only users, user emails, GitHub connections and sessions exist.
- `apps/api/src/app.ts:38`: only health, auth and profile routes are registered.
- `apps/api/src/env.ts:27`: configuration validation does not yet expose Meta, Modal, Google or the GitHub App private key, regardless of credentials reportedly added to the environment.
- `apps/web/src/App.tsx:118`: profile/install-status display only. The repository picker and selected-repository breakdown are still to be built.

Keep Fastify, TypeScript, Drizzle/Postgres, React and shared Zod contracts. No framework rewrite is warranted. The wiki directory contains no ClearHire project wiki; no unrelated personal career material was loaded.

## 2. Reference backend: what is useful

Reviewed `TheCl3m/llama-hack` at commit `c07af10f61a50e2e12b8600b3492504f952eb8ab`. It is an activity summarization prototype, not an exact expertise evaluator.

| Component inspected | Actual behavior | ClearHire decision |
| --- | --- | --- |
| [`backend/fetch.py`](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/backend/fetch.py#L101) | Paginates contributors, closed issues and commits; gathers details for up to 500 issues/commits. PR entries are explicitly excluded at line 245. Associates issues with assignees and commits with `author.login`; drops unmapped authors. Keeps changed-file patches but no full source architecture. Truncates messages, losing coauthor trailers. | Independently implement diff-first evidence collection, pagination and source links. Add bounded collection, PRs, full attribution and source context. Never equate issue assignment with implementation. |
| [`api/models.py`](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/backend/api/models.py#L33) and [`populate.py`](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/backend/api/management/commands/populate.py#L192) | Separates repositories, contributors, contributor/repository work, issues and commits from summaries. Reimports clear summaries even when evidence has not changed. | Recreate the useful evidence/interpretation separation in Drizzle, with immutable provenance and content/version cache keys. Do not introduce Django or copy the importer. |
| [`create_summaries.py`](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/backend/api/management/commands/create_summaries.py#L21) | Issue/commit summaries → person/repository summaries → person summary. Uses Llama 4 Maverick through the older Llama API, eight workers, short outputs and no evidence-validation rubric. Prompts can infer deep expertise from compressed descriptions. | Reimplement staged compression and bounded concurrency, preserving source IDs. Replace prose-only expertise inference with strict schemas, a conservative rubric, source checks and Muse Spark. Summaries route retrieval; original code supports verdicts. |
| [`api/views.py`](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/backend/api/views.py#L75) | Includes all repositories/contributors and nested activity summaries in chat context. | Do not port this. Retrieve only evidence relevant to a feature or requirement. No chat UI is needed. |

The reference also has demo-oriented access/settings and an empty test scaffold; it does not provide the production security, validation or evaluation foundation ClearHire needs. Its [LICENSE](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/LICENSE) is CC BY-NC 4.0 and its [README](https://github.com/TheCl3m/llama-hack/blob/c07af10f61a50e2e12b8600b3492504f952eb8ab/README.md) explicitly restricts commercial use without permission. Recommendation: independently implement the patterns above; obtain suitable permission before copying or adapting its code for commercial ClearHire use.

## 3. Architecture and decisions

Flow: authenticated repo selection → authorized immutable snapshot → deterministic filtering/static facts → contribution evidence → bounded source packets → model interpretation → deterministic and semantic validation → stored technical breakdown/skills → requirement matching.

**Sandbox:** running each candidate's project is unnecessary for this product. Never run repository scripts, package installs, builds, tests, hooks or repository-supplied parser configuration. Static inspection can establish what code implements and whether particular safeguards exist; it cannot establish that the program works in production or that tests pass.

Modal is therefore not needed as a project execution environment. Retain it as an isolation boundary for the to-do list's archive download/unpacking and fixed parser code. This protects the API process from malformed archives, excessive resource use and parser failures. A bounded worker retrieving selected GitHub tree/blob objects is a possible later alternative, not an additional implementation track. The first version follows the supplied Modal design.

Only repository-scoped, short-lived read credentials enter the downloader. Database credentials, Meta credentials and the GitHub App private key remain outside. Require CPU/memory/time/file/byte limits, safe extraction, and termination in `finally`. Verify how the SDK enforces egress before promising that networking can be disabled midway; if it cannot, use a GitHub-only downloader stage followed by a separate offline parser stage. No untrusted source execution occurs in either stage.

**Evidence:** store project capability separately from candidate attribution. Every personal skill claim needs both semantic support and contribution provenance. A valid quote proves that code exists, not who conceived it or whether the skill level is justified.

**Coverage:** incomplete downloads, capped history, unknown authorship, unavailable models and insufficient evidence are distinct conditions. Do not turn infrastructure failure into a negative assessment of a candidate.

## 4. Step-by-step build, in the supplied order

### 0 — Accounts and keys

Extend `env.ts` to validate the planned provider settings. Keep secrets server-side and redacted from logs; follow the repository instruction not to inspect/edit environment files. Verify provider access during implementation using minimal smoke requests, without printing credentials. The attachment's checked boxes are not proof that every integration is operational.

Use `muse-spark-1.3` at `https://api.meta.ai/v1`; confirm entitlement and credit balance in the actual account. Default to Standard mode for candidate code. Meta documents that Contributor mode permits training on submitted content. Do not choose it simply to reduce cost. [Meta pricing](https://dev.meta.ai/docs/pricing-rate-limits)

Done when GitHub repository authorization, a bounded Meta JSON response and Modal start/stop are verified. Google verification belongs here before phase 2's integration.

### 1 — Foundations

Add shared Zod contracts first, then schema/migrations, model adapter and pg-boss jobs. Retain existing sessions/token encryption. Add the tables from the to-do list, plus explicit contribution and breakdown storage:

| Group | Required data |
| --- | --- |
| Identity/access | Roles, password/OAuth accounts, employer/candidate profiles, authorized installations and repository grants |
| Jobs/inputs | Job requirements with versions/weights, interests, parsed résumé text |
| Source | Repository ID, snapshot SHA, files/content hashes, skipped-file reasons, static facts, source chunks with exact ranges |
| Provenance | Commits, parent SHAs, changed files/hunks, PRs and reviews, account IDs, coauthor metadata, attribution status and uncertainty |
| Analysis | Run status/stage, coverage, caps, errors, model/prompt/parser/rubric versions, technical breakdowns, skills and evidence |
| Matching/cost | Requirement verdicts, evidence IDs, requirement/analysis versions, match denominator, model calls and cost reservations |

Prefer immutable source and analysis versions. Deduplicate repository snapshots by GitHub repository ID + SHA; files by snapshot + path; commits by repository + SHA; matches by candidate + job + version, with an explicit current result. Source caches and access to them must respect repository permissions; never expose another candidate's private results through a shared hash.

Run ingest → analyze → match through pg-boss, initially in the API process as planned. Add idempotency, bounded retries, cancellation, crash recovery, stage progress, and completed/partial/failed states. Queue retries on provider throttling rather than holding a worker open.

The model adapter must enforce schema validation, timeout, bounded repair/retry, maximum output, and a per-analysis spend cap. Reserve estimated maximum cost atomically before dispatch so concurrent calls cannot overspend the cap. Log usage, cached tokens, latency, finish reason, errors and task/version identifiers, without raw credentials or source in routine logs. Cache only validated results using the complete input hash and relevant versions. Use Chat Completions strict `json_schema` output; require properties and forbid additional properties, using nullable values for unknowns. Validate again with Zod. [Meta structured output](https://dev.meta.ai/docs/structured-output)

Done when a fake provider can drive a job through success, partial completion and failure without duplicate rows or unbounded spending.

### 2 — Sign-in and roles

Keep candidate GitHub sign-in. Add employer password/Google sign-in and profiles in the to-do list's order, sharing sessions and enforcing server-side role checks. Make GitHub-specific user fields optional for employers. Implement the planned account-linking safeguards and authentication rate limits.

Extend installation handling beyond the single own-account installation. Verify that the requesting person can access the selected repository and that the app has permission; an installation token's broad access must not become the user's authorization. Recheck access before ingestion, result reads and source disclosure. Protect cookie-authenticated mutations against cross-site requests.

Done when candidate/employer boundaries and organization repository access are exercised with separate accounts. Keep email verification/password recovery as the attachment's stretch items.

### 3 — Employers: jobs

Implement the planned job endpoints and description-to-requirements extraction. Model output proposes requirements; the employer approves names, levels and weights. Use a normalized taxonomy, preserve the original requirement text, version edits, and validate nonnegative weights with a positive total before scoring. Requeue matching when an approved requirement version changes.

Done when an employer can publish a reviewed requirement list and edit it without stale match results being presented as current.

### 4 — Candidates: profile and inputs

Implement job interests, authorized repository listing/picker, résumé upload/parsing, and `POST /analyses` with `GET /analyses/:id`. Resolve selected repository IDs on the server, not arbitrary download URLs. Flag forks without treating all forks as worthless: an upstream fork may contain valuable original contributions.

Return one analysis ID and per-repository progress. Retain upload limits and show extracted résumé text for confirmation. Candidate-controlled evidence sharing must not expose private repository text to an employer just because the candidate can access it; source access and permitted result disclosure are separate concerns.

Done when the picker starts an authorized queued job and shows honest progress/failure. Technical breakdown rendering waits until phase 8.

### 5 — Repository ingestion

Pin each selected repo to its resolved default-branch SHA. Download only that snapshot inside the isolated ingestion worker. Safely extract with compressed/unpacked byte, file-count and per-file limits; reject traversal, links and special files. Record omissions, not just kept content. Apply time/memory limits to parsers too. Validate returned JSON before persisting.

Exclude `node_modules`, vendored dependency trees, build outputs, minified bundles, binaries and generated code from model input. Keep first-party source, relevant tests, migrations, configuration, CI workflows, manifests and selected documentation. Parse manifests locally into dependency facts; do not send the complete installed packages or lockfiles. Preserve `.github` when relevant. Redact likely credentials before any provider call and exclude affected snippets from exact-quote evidence if their original text cannot safely be sent.

Extract deterministic facts without a model: languages, direct dependencies, imports/exports, entry points, routes, schemas, tests, CI steps and available static checks. Label dependencies as declared and tests as present; neither means proficient or passing. Use syntax-aware chunking where supported, with bounded line chunks as fallback. Keep original source line mappings.

Fetch bounded default-branch history plus candidate PR/commit evidence relevant to the snapshot. Keep parent commits and changed hunks; fetch complete base/head blobs when a patch is missing or truncated, within budget. Treat deleted-code contributions as historical evidence at the relevant commit, never pretend they occur in the current snapshot. Capture reviewed PR changes separately from code authored by the candidate.

Use stable GitHub account IDs, linked author identities, author/committer separation, coauthor trailers and signature status. Verified profile email matching is an identity hint; raw commit author metadata remains forgeable. Use line blame and change-hunk mapping to connect the **specific cited lines** to contributions; file-wide added-line percentages must never grant credit for somebody else's function. Blame is supporting evidence, not infallible ownership—formatting, moves, squash merges and imported code require caution.

Mark attribution as supported, shared, ambiguous or unknown. Keep unknown records. A fork with no observed candidate contributions earns no attributed evidence within the inspected history; a history cap means incomplete coverage, not proof there were never contributions. Report inspected commits/files and skipped ranges. Handle GitHub pagination, rate limits and truncated responses explicitly. [GitHub trees](https://docs.github.com/en/rest/git/trees)

Done when re-ingestion is idempotent, archive attacks are rejected, and two contributors touching one file receive evidence only for appropriately attributed changes.

### 6 — Skill analysis and repository breakdown

Start with deterministic technique candidates, then ask Muse Spark to interpret selected implementation evidence. Use a small fixed taxonomy with aliases, but retain specific techniques such as cursor pagination, idempotent job handling or transactional updates as subclaims. Language/framework presence alone remains repository context.

Construct packets around a coherent feature: entry point → relevant implementation → data model → error handling → tests. Include the candidate's changed hunks, the surrounding function and limited direct dependencies/callers needed to understand the feature. Select for functional importance, authorship relevance and coverage across subsystems; file size alone is a poor priority signal. Preserve small but important authorization, transaction and concurrency code.

Each packet contains source IDs, paths, SHA, original line ranges, compact static facts and attribution metadata. Ask for concise structured observations, proposed skill level, supporting evidence IDs/ranges, quality strengths, limitations and missing context. Let the server render exact quotes from those ranges; if a model emits a quote, verify it byte-for-byte against the same stored snapshot. Never synthesize evidence from summaries. Treat code, comments, README text, issues and PR discussions as untrusted evidence, not instructions. Delimit them, explicitly forbid obeying embedded instructions, and give the analysis model no execution tools or arbitrary network retrieval. Delimiters alone are not a security guarantee; validation and restricted capabilities remain necessary.

Perform deterministic checks first: schema, allowed skill, source/range validity, quote match, attribution, redaction and coverage. Reject fabricated or unattributable claims. Then perform a bounded semantic verification using original snippets and the explicit rubric. A failed check must reject or downgrade with a reason; an unavailable verifier leaves the assessment unverified. A second model pass is another assessment, not independent proof.

| Level | Evidence required |
| --- | --- |
| Used | Attributable implementation of the technique; importing a package alone is insufficient |
| Solid | Coherent implementation with relevant validation/error handling and edge-case or test evidence |
| Advanced | Evidence of a demanding design constraint and well-executed handling of it, such as concurrency, recovery or performance tradeoffs; complexity alone is insufficient |

Track attribution confidence, semantic confidence and coverage separately from level. Assess correctness, robustness, testing, maintainability and security only where source supports a specific observation. Say “test cases cover retry exhaustion,” not “the tests pass.” Missing evidence does not prove a low skill level. Repeated independent examples can strengthen a skill assessment; copied boilerplate and mirrored repositories must not multiply credit.

Persist both the repository-level technical breakdown and the candidate-specific demonstrated skills, with claim → evidence links and model/prompt/rubric versions. Cache source interpretations independently from candidate attribution, then recompute personal credit for each candidate. Invalidate affected summaries when relevant dependency/context hashes change, not only when the summarized file changes.

Done when every displayed technical assertion has a source or is visibly labeled an inference, and every personal skill has specific contribution support.

### 7 — Matching

Match only selected/interested candidate-job pairs. Retrieve normalized skills first, then search eligible attributed source evidence for unmet requirements. Use the model only for the unresolved semantic comparison. Reuse validated analysis; do not resubmit the entire repository for each job.

Retain the business verdicts met, partly met and not shown. Add a separate evaluation status such as complete/unavailable/partial. **Correction to the attachment:** malformed model output is an unavailable evaluation, not evidence that a candidate lacks the requirement. Never default to met. “Not shown” means not demonstrated in the inspected eligible evidence; visibly disclose coverage limits.

Compute weighted points in code: met = 1 × weight, partly met = 0.5 × weight, not shown = 0. Preserve the full denominator. For incomplete evaluations, show a provisional confirmed-points result with the number of unevaluated requirements; do not publish it as a final rank or quietly remove missing requirements from the denominator. With zero total weight, show unscored rather than dividing by zero. A match percentage measures evidence coverage against requirements, not probability of job success.

Done when every awarded point has an evidence trail and retrying a match replaces the current version without duplicating it.

### 8 — Minimal results screens

Keep the planned candidate/employer results, but add no separate repository analytics dashboard. Under each selected repository, provide a single expandable “Technical breakdown” section:

| Field | Content |
| --- | --- |
| What it does | Short purpose statement and main functional components |
| How it works | Specific technical techniques, with code links |
| Execution quality | Supported strengths, gaps and “not assessed” where appropriate |
| Your contribution | Attributed functions/changes, shared or ambiguous ownership |
| Demonstrated skills | Level, brief reason and attribution/coverage qualifications |
| Evidence/status | Exact snapshot/commit links and line ranges; partial coverage or failed stage |

Use `GET /analyses/:id/repos/:repoId/breakdown` or an equivalent owner-authorized route backed by stored results. Do not rerun model analysis when the panel opens. Candidate evidence and employer disclosure must obey access rules. Display neutral empty/error states; no fabricated preview results, radar charts, badges implying human-only authorship or extra navigation.

Done when the candidate can inspect why a selected repo produced each skill, and an employer can trace a permitted match verdict to evidence.

### 9 — Testing and demo preparation

Use an offline Meta fake for routine development. Add fixtures that test the risks, not just implementation details: fabricated/shifted quotes; one file with two authors; ambiguous coauthors; squash/merge commits; untouched fork; shallow/capped history; missing/truncated patches; copied code; provider failure; budget exhaustion; archive traversal and decompression limits; inaccessible private repository; job with no supported requirements; zero-weight jobs; duplicate job delivery.

Create a small human-reviewed set of repositories/commits with known technical features and contribution owners. Evaluate claim precision, attribution accuracy, quote validity, appropriate abstention, token cost and coverage. “Strong repo scores above weak repo” alone is inadequate because repo quality and candidate contribution can differ.

Then run the attachment's minimum end-to-end demo: one employer, one job, one candidate, one public repo, a technical breakdown and evidence-backed matching on both sides. Run the repository's prescribed typecheck/tests after implementation. Record actual Meta/Modal spend and set operational caps from measurements. Keep the attachment's stretch items out of this first completion target.

## 5. Using Muse Spark credits efficiently

Do deterministic discovery and attribution locally. Spend model tokens on interpreting feature implementations and checking disputed skill/requirement claims. Use bounded structured outputs rather than essays or a model call per commit/file. Batch closely related evidence into feature packets, not one giant repository prompt.

Cache validated interpretations by full input/context hash, model and prompt/parser/rubric versions. Cache matching by analysis version and requirement version. Keep stable rubric/schema text before changing evidence to benefit from automatic provider prefix caching; application caching avoids the call entirely. Reprocess changed features and their dependents only. Set hard limits on retrieval expansions, retries, input/output and spend; when reached, return useful partial results with coverage. No public batch-processing discount was verified, so the budget does not assume one. [Meta caching](https://dev.meta.ai/docs/prompt-caching)

Current published Standard rates are $1.25 per million uncached input tokens, $0.15 cached input and $4.25 output. For illustration, 30,000 uncached input plus 4,000 output across a small repo's calls costs about **$0.0545**, excluding retries and other services. This is a budgeting example, not a quality target or measured ClearHire cost. Output and repeated verification can dominate, so log actual usage and tune against the evaluation set. No credit balance or usable credit terms were verified in this review. [Meta pricing](https://dev.meta.ai/docs/pricing-rate-limits)

## 6. Two contributors both using Claude Code

GitHub can associate changes with accounts; it cannot establish which human thought through, typed, prompted or understood the resulting implementation. The same limitation applies when neither contributor discloses AI assistance. Claude coauthor trailers, commit signatures and a PR creator are provenance signals, not proof of independent proficiency.

Identify the accounts associated with the precise commit/hunk, distinguish author from committer/merger, retain coauthors, and use PR discussion/review evidence to support claims about design or review work separately. Do not infer authorship from coding style or divide credit arbitrarily. Shared changes remain shared; ambiguous changes remain ambiguous. Repo ownership gives no automatic personal credit.

Phrase the result as “this account contributed an implementation demonstrating X,” with the evidence and uncertainty. “This person independently has advanced X expertise” requires additional verification—such as explaining the design or making a controlled change—and is outside the requested initial backend. No AI detector or new interview UI is proposed.

Official references: [GitHub coauthors](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors), [signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/displaying-verification-statuses-for-all-of-your-commits), [squash/merge behavior](https://docs.github.com/en/pull-requests/reference/pull-request-merges). Isolation references: [Modal Sandboxes](https://modal.com/docs/guide/sandboxes), [networking/security](https://modal.com/docs/guide/sandbox-networking). These document the underlying mechanisms; the assessment rubric and architecture above are ClearHire design recommendations.
