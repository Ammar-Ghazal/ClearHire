/plan Finalize component five using the existing pipeline and the local resume PDFs now provided. Do not implement yet.

1. Use the supplied resume files.
Read data/demo/resumes/README.md and manifest.json. There are 25 PDFs: 13 original published resumes and 12 public-source demo reconstructions. Match manifest keys to existing candidate keys. LinkedIn and portfolio URLs are provenance, not resume inputs. Preserve document kind, sources and limited-source flags. The three additional profiles without resumes remain valid demo records with resume status none. HKUDS is a lab organization; do not treat its repositories as Chao Huang's personal work.

2. Reuse existing components.
Keep ingestRepo, collectContributions, buildCandidateEvidence, serializePreparedCandidate, parsePreparedCandidate, assessment locks, spend accounting, verification, matchAssessments and priority-override storage. Leave matchSaved unchanged for CLI callers. Extract the existing candidate/job fingerprint logic without changing cache-key behavior, including the no-attributed-evidence branch that makes no Muse call. Add read-only lookup and verification by exact cache key.

3. Add the minimum data integration.
Create the three proposed demo tables and one import script. Validate fixture references and duplicate identities with Zod. Preserve established candidate keys and compare GitHub identities case-insensitively. Store prepared data using the existing serialization helpers. Keep demo subjects separate from authenticated users.

Detect profile, prepared-data, PDF and job-input changes independently. Hash employerId, title, text and textSource for analyzed job inputs. Clear incompatible overrides when posting identity or analyzed inputs change. Refuse import changes to a subject while its run is pending. Read files and extract PDFs before the database transaction.

4. Extract the local PDFs during import.
Use one pinned PDF extraction dependency. Cache text by PDF hash, enforce file/page limits and flag extraction failures or scanned files. Defer OCR, Word parsing, URL downloads and upload UI. Keep original PDFs unchanged. Handle replaced and removed PDFs, and attach only the current extracted text; ignore stale resume text inside prepared snapshots. Treat resume content as restricted under the existing data-use check and never switch models automatically. Resume statements remain claims, including statements in reconstructed documents; they do not establish code-verified skills. Keep PDF bytes and extracted text out of public responses. Do not add workers or claim a hard extraction timeout that the parser cannot enforce.

5. Prepare only what is missing.
Discard preparation when subject or identity mismatches. Remove deselected repositories. Reuse valid pinned snapshots and verify collectedFor and collected.repository consistency. Fetch only missing or invalid selected repositories. Recorded unavailable entries remain visible as incomplete evidence. Every selection must have either a valid snapshot or an unavailable entry before analysis.

An explicit Retry may re-fetch transient GitHub failures before the assessment-cache shortcut, including after a partial result. Normal Analyze reuses preparation. Unchanged evidence reuses the assessment. Do not automatically retry paid calls or refresh pinned commits.

6. Wire explicit runs and reads.
Keep run state separate from assessment freshness. Claim with a run token before returning 202; heartbeat during preparation; condition writes on ownership; recheck ownership before analysis; persist safe failures and clear the heartbeat on completion. Recover stale runs on explicit start/retry and startup. Reuse assessment locks and spending limits. Add no queue or scheduling.

Candidate/job lists must load without Muse credentials. Show configuration errors without turning public reads into 500 responses. Keep /me authenticated, add isDemoOperator to its shared schema and enforce the allowlist on mutations. Return explicit public fields, not database rows. GET requests, matching and priority updates must never call GitHub or Muse.

7. Keep one plain test screen.
Include candidate/job selectors, source and resume-extraction status, Analyze/Retry buttons, expandable repository findings and evidence links, editable priorities with Reset, and compatibility/evidence coverage. Hide mutations from non-operators. Disable actions while pending and ignore responses for previous selections.

Build breakdowns from selected repositories, filter evidence by repository and label skill levels candidate-wide. Show duplicated-file notices without classifying an entire repository as a duplicate from one file. Match only current verified assessments through matchAssessments. Mark fixture-summary matches provisional. Handle out-of-scope jobs without requiring assessments. Keep absent/outdated analyses unscored.

8. Verify the demo flow.
Check all 25 manifest entries resolve to readable PDFs and existing candidate keys. Test idempotent imports, PDF replacement/removal, partial preparation, explicit transient retries despite a cached result, exact fingerprint reuse, duplicate starts, stale ownership, missing configuration and priority recalculation without paid calls. Pure tests always run; report skipped database tests. Run typecheck, tests and build. Keep paid smoke tests explicit and optional.

Return a short implementation sequence with affected files and acceptance checks. Remove repeated explanations and speculative infrastructure. Do not add features or recreate the supplied resumes. Do not implement yet.
