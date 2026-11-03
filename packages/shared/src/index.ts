// Schemas shared by the API and the web app. One definition, one source of truth.
import { z } from 'zod';
import { SKILL_CATALOGUE, SKILL_IDS } from './skill-catalogue.js';

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['up', 'down']),
  githubConfigured: z.boolean(),
});
export type Health = z.infer<typeof HealthSchema>;

export const MeSchema = z.object({
  id: z.string().uuid(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  emails: z.array(z.object({ email: z.string(), verified: z.boolean(), primary: z.boolean() })),
  github: z.object({
    installationId: z.number().int().nullable(),
    installUrl: z.string().url().nullable(),
  }),
  /** Allowlisted operators may start demo analyses and change priorities. */
  isDemoOperator: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---- Skill assessments and matching ----

export { SKILL_CATALOGUE, SKILL_IDS } from './skill-catalogue.js';
export type { CatalogueCategory, CatalogueSkill, LevelCriteria } from './skill-catalogue.js';

export const SkillIdSchema = z.enum(SKILL_IDS);
export const SkillLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const LevelCriteriaSchema = z.object({
  requires: z.string().min(1),
  examples: z.string().min(1).optional(),
});

/** The one skill standard that Muse and both benchmark evaluators receive. */
export const SkillCatalogueSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  provenance: z.string(),
  supportingTags: z.string(),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
  skills: z.array(
    z.object({
      id: SkillIdSchema,
      name: z.string(),
      categoryId: z.string(),
      definition: z.string(),
      levels: z.object({ 1: LevelCriteriaSchema, 2: LevelCriteriaSchema, 3: LevelCriteriaSchema }),
    }),
  ),
});

/** 0 means not demonstrated in the reviewed evidence. */
export const MarkerLevelSchema = z.number().int().min(0).max(3);

/**
 * One evaluator's decision on one marker for one benchmark packet: the level it expects from the
 * evidence, the level Muse returned and whether they agree.
 */
export const MarkerDecisionSchema = z.object({
  skill_id: SkillIdSchema,
  expected_level: MarkerLevelSchema,
  muse_level: MarkerLevelSchema,
  agrees: z.boolean(),
  reason: z.string(),
  evidence_refs: z.array(z.string()),
});
export type MarkerDecision = z.infer<typeof MarkerDecisionSchema>;

/** A complete review of one packet: exactly one decision for every catalogue marker. */
export const MarkerReviewSchema = z
  .object({ id: z.string(), markers: z.array(MarkerDecisionSchema) })
  .superRefine((review, ctx) => {
    const seen = new Set(review.markers.map((m) => m.skill_id));
    if (seen.size !== review.markers.length || seen.size !== SKILL_IDS.length) {
      ctx.addIssue({ code: 'custom', message: 'Every marker must appear exactly once' });
    }
    for (const m of review.markers) {
      if (m.agrees !== (m.expected_level === m.muse_level)) {
        ctx.addIssue({ code: 'custom', message: `${m.skill_id}: agrees contradicts the levels` });
      }
      if (m.expected_level > 0 && m.evidence_refs.length === 0) {
        ctx.addIssue({ code: 'custom', message: `${m.skill_id}: a positive level needs evidence` });
      }
    }
  });
export type MarkerReview = z.infer<typeof MarkerReviewSchema>;
export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const PrioritySchema = z.number().int().min(0).max(3);
export const CatalogueRefSchema = z.object({
  id: z.literal(SKILL_CATALOGUE.id),
  version: z.number().int().positive(),
});

/** `unknown` lines are context only: they never support a personal skill. */
export const AttributionSchema = z.enum(['sole', 'shared', 'provisional', 'unknown']);

/** One contribution to one repository copy: `repo`, `path` and `snapshotSha` identify the copy. */
export const ContributionRefSchema = z.object({
  repo: z.string(),
  path: z.string(),
  snapshotSha: z.string(),
  commitSha: z.string(),
  prNumber: z.number().int().nullable(),
  authorship: z.enum(['sole', 'shared', 'undetermined']),
  provisional: z.boolean(),
  aiCoauthorDeclared: z.boolean(),
});

export const OccurrenceSchema = z.object({
  repo: z.string(),
  path: z.string(),
  commitSha: z.string(),
});

/** A server-rendered location in stored, redacted evidence; never text written by the model. */
export const EvidenceRefSchema = z.object({
  ref: z.string(),
  repo: z.string(),
  commitSha: z.string(),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** SHA-256 of the original lines, so a later display can detect any mismatch. */
  sha256: z.string(),
  attribution: AttributionSchema.nullable(),
  contributions: z.array(ContributionRefSchema),
  /** Identical copies in other repositories; they never inherit this copy's attribution. */
  alsoIn: z.array(OccurrenceSchema),
  note: z.string().nullable(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** A GitHub blob link pinned to the stored snapshot's commit and the exact line range. */
export const evidenceUrl = (
  ref: Pick<EvidenceRef, 'repo' | 'commitSha' | 'path' | 'startLine' | 'endLine'>,
) =>
  `https://github.com/${ref.repo}/blob/${ref.commitSha}/${encodePath(ref.path)}` +
  `#L${ref.startLine}-L${ref.endLine}`;

const SupportedClaimSchema = z.object({ summary: z.string(), refs: z.array(EvidenceRefSchema) });

export const RepositoryFindingSchema = z.object({
  repo: z.string(),
  functionality: z.array(SupportedClaimSchema),
  qualityObservations: z.array(
    z.object({
      kind: z.enum(['strength', 'concern']),
      observation: z.string(),
      refs: z.array(EvidenceRefSchema),
    }),
  ),
  limitations: z.array(z.string()),
  /** Null when the model's contribution summary had no valid attributed references. */
  contribution: SupportedClaimSchema.nullable(),
});

export const AttributionLimitationSchema = z.enum([
  'shared_authorship',
  'provisional_landing',
  'ai_coauthor_declared',
  'sampled_evidence',
]);

export const DemonstratedSkillSchema = z.object({
  skillId: SkillIdSchema,
  level: SkillLevelSchema,
  confidence: ConfidenceSchema,
  rationale: z.string(),
  supportingTags: z.array(z.string()),
  evidence: z.array(EvidenceRefSchema).min(1),
  attributionLimitations: z.array(AttributionLimitationSchema),
});
export type DemonstratedSkill = z.infer<typeof DemonstratedSkillSchema>;

export const UnsupportedSkillSchema = z.object({
  skillId: SkillIdSchema,
  level: SkillLevelSchema,
  invalidRefs: z.array(z.string()),
});

export const EvidenceCoverageSchema = z.object({
  evidence: z.enum(['complete', 'sampled']),
  unavailableRepos: z.array(z.object({ repo: z.string(), reason: z.string() })),
  omissions: z.array(
    z.object({
      repo: z.string(),
      path: z.string(),
      reason: z.string(),
      startLine: z.number().int().nullable(),
      endLine: z.number().int().nullable(),
    }),
  ),
  duplicates: z.array(OccurrenceSchema.extend({ duplicateOf: z.string() })),
  /** Capped history, missing patches and failed lookups: attribution may be incomplete. */
  attributionGaps: z.array(
    z.object({
      repo: z.string(),
      reason: z.string(),
      commitSha: z.string().nullable(),
      path: z.string().nullable(),
    }),
  ),
  limitations: z.array(z.object({ repo: z.string(), limitation: z.string() })),
});

export const AssessmentSubjectSchema = z.object({
  kind: z.enum(['demo', 'user']),
  key: z.string().min(1),
});

/** Only `complete`, `partial` and `no_attributed_evidence` assessments are ever saved as results. */
export const CandidateAssessmentSchema = z.object({
  kind: z.literal('candidate'),
  subject: AssessmentSubjectSchema,
  model: z.string(),
  catalogue: CatalogueRefSchema,
  status: z.enum(['complete', 'partial', 'no_attributed_evidence']),
  verification: z.literal('location_verified_not_competency'),
  coverage: EvidenceCoverageSchema,
  repositories: z.array(RepositoryFindingSchema),
  skills: z.array(DemonstratedSkillSchema),
  unsupportedSkills: z.array(UnsupportedSkillSchema),
});
export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>;

const JobTextRefSchema = z.object({ ref: z.string(), text: z.string() });

/** Every schema-valid requirement is kept; failed source references are flagged for review. */
export const JobRequirementSchema = z.object({
  skillId: SkillIdSchema,
  requiredLevel: SkillLevelSchema,
  suggestedPriority: PrioritySchema,
  refs: z.array(JobTextRefSchema),
  referenceStatus: z.enum(['verified', 'needs_review']),
  invalidRefs: z.array(z.string()),
});
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

export const JobAssessmentSchema = z.object({
  kind: z.literal('job'),
  jobKey: z.string().min(1),
  employerId: z.string().nullable(),
  title: z.string(),
  model: z.string(),
  catalogue: CatalogueRefSchema,
  textSource: z.enum(['full_description', 'source_summary', 'fixture_summary']),
  inScope: z.boolean(),
  outOfScopeReason: z.string().nullable(),
  requirements: z.array(JobRequirementSchema),
  eligibilityConstraints: z.array(
    z.object({ summary: z.string(), refs: z.array(JobTextRefSchema) }),
  ),
  supportingTags: z.array(z.string()),
});
export type JobAssessment = z.infer<typeof JobAssessmentSchema>;

export const PriorityOverrideSchema = z.object({
  jobKey: z.string().min(1),
  skillId: SkillIdSchema,
  priority: PrioritySchema,
});
export type PriorityOverride = z.infer<typeof PriorityOverrideSchema>;

export const MatchRequirementSchema = z.object({
  skillId: SkillIdSchema,
  requiredLevel: SkillLevelSchema,
  priority: PrioritySchema,
  prioritySource: z.enum(['override', 'suggested']),
  referenceStatus: z.enum(['verified', 'needs_review']),
  /** `below_required` is an assessed shortfall; `not_demonstrated` means no supported assessment. */
  verdict: z.enum(['met', 'partly_met', 'below_required', 'not_demonstrated']),
  credit: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  candidateLevel: SkillLevelSchema.nullable(),
  /** Display only: confidence never changes the score. */
  confidence: ConfidenceSchema.nullable(),
  evidence: z.array(EvidenceRefSchema),
});

const MatchBaseSchema = z.object({
  subject: AssessmentSubjectSchema,
  jobKey: z.string(),
  catalogue: CatalogueRefSchema,
  requirements: z.array(MatchRequirementSchema),
  eligibilityConstraints: z.array(z.string()),
});

export const MatchResultSchema = z.discriminatedUnion('status', [
  MatchBaseSchema.extend({
    status: z.literal('scored'),
    /** 100 × Σ(priority × credit) / Σ priority, over requirements with priority > 0. */
    compatibility: z.number().min(0).max(100),
    /** 100 × Σ(priority of requirements with a supported assessment) / Σ priority. */
    evidenceCoverage: z.number().min(0).max(100),
    provisional: z.boolean(),
  }),
  MatchBaseSchema.extend({
    status: z.literal('unscored'),
    reason: z.enum(['out_of_scope', 'zero_priority']),
  }),
]);
export type MatchResult = z.infer<typeof MatchResultSchema>;

// ---- Demo screen ----

/** Run state of one demo subject, separate from whether its saved assessment is current. */
/** `queued` waits for the analysis worker; `pending` is fetching and grading. */
export const RunStatusSchema = z.object({
  status: z.enum(['idle', 'queued', 'pending', 'failed']),
  errorCode: z.string().nullable(),
});
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Whether a saved assessment matches the subject's current inputs. Only `current` results are
 * shown or scored; `outdated` means only results for older inputs or versions exist.
 */
export const FreshnessSchema = z.object({
  state: z.enum([
    'current',
    'pending',
    'failed',
    'outdated',
    'not_started',
    'not_applicable',
    'model_not_configured',
  ]),
  /** Saved status when current: complete, partial or no_attributed_evidence. */
  assessmentStatus: z.enum(['complete', 'partial', 'no_attributed_evidence']).nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export const ResumeInfoSchema = z.object({
  status: z.enum(['none', 'extracted', 'needs_review']),
  reviewReason: z.string().nullable(),
  kind: z.enum(['original_public_resume', 'reconstructed_demo_resume']).nullable(),
  limitedSource: z.boolean(),
  sources: z.array(z.string()),
  limitations: z.array(z.string()),
  pages: z.number().int().nullable(),
  /** The profile's resume link: provenance only, never fetched. */
  resumeUrl: z.string().nullable(),
  resumeType: z.string().nullable(),
});

export const DemoCandidateSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  githubUrl: z.string(),
  githubLogin: z.string(),
  organization: z.boolean(),
  repositoryCount: z.number().int(),
  resume: ResumeInfoSchema,
  run: RunStatusSchema,
});
export type DemoCandidateSummary = z.infer<typeof DemoCandidateSummarySchema>;
export const DemoCandidateListSchema = z.array(DemoCandidateSummarySchema);

export const EvidenceLinkSchema = EvidenceRefSchema.pick({
  path: true,
  startLine: true,
  endLine: true,
  commitSha: true,
  attribution: true,
}).extend({ url: z.string() });

const LinkedClaimSchema = z.object({ summary: z.string(), evidence: z.array(EvidenceLinkSchema) });

export const RepositoryBreakdownSchema = z.object({
  repo: z.string(),
  url: z.string(),
  pinnedSha: z.string().nullable(),
  commitSha: z.string().nullable(),
  state: z.enum([
    'analyzed',
    'not_described',
    'no_attributed_evidence',
    'unavailable',
    'pending',
    'failed',
    'outdated',
    'not_analyzed',
  ]),
  /** Unavailable or failure code; never an exception message. */
  reason: z.string().nullable(),
  functionality: z.array(LinkedClaimSchema),
  quality: z.array(
    z.object({
      kind: z.enum(['strength', 'concern']),
      observation: z.string(),
      evidence: z.array(EvidenceLinkSchema),
    }),
  ),
  limitations: z.array(z.string()),
  contribution: LinkedClaimSchema.nullable(),
  skills: z.array(
    z.object({
      skillId: SkillIdSchema,
      name: z.string(),
      level: SkillLevelSchema,
      confidence: ConfidenceSchema,
      rationale: z.string(),
      /** `candidate_wide`: the level was assessed across several repositories. */
      levelScope: z.enum(['repository', 'candidate_wide']),
      attributionLimitations: z.array(AttributionLimitationSchema),
      evidence: z.array(EvidenceLinkSchema),
    }),
  ),
  /** File-level: identical files whose evidence is shown under another copy. */
  duplicates: z.array(z.object({ path: z.string(), duplicateOf: z.string() })),
  coverage: z.object({
    sampled: z.boolean(),
    omittedRanges: z.number().int(),
    attributionGaps: z.array(
      z.object({
        reason: z.string(),
        commitSha: z.string().nullable(),
        path: z.string().nullable(),
      }),
    ),
    limitations: z.array(z.string()),
  }),
});
export type RepositoryBreakdown = z.infer<typeof RepositoryBreakdownSchema>;

export const DemoCandidateSchema = DemoCandidateSummarySchema.extend({
  verification: z.object({
    identityMatchVerified: z.boolean().nullable(),
    publicRepositoriesVerified: z.boolean().nullable(),
    source: z.string().nullable(),
    userSuppliedStatus: z.string().nullable(),
  }),
  freshness: FreshnessSchema,
  /** Unavailable repositories whose failure was transient; a regrade fetches them again. */
  transientRepos: z.array(z.string()),
  repositories: z.array(RepositoryBreakdownSchema),
});
export type DemoCandidate = z.infer<typeof DemoCandidateSchema>;

export const DemoJobSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  employer: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    description: z.string(),
    location: z.string().nullable(),
  }),
  location: z.string().nullable(),
  sourceUrl: z.string(),
  sourceChecked: z.string().nullable(),
  inScope: z.boolean(),
  /** `source_summary`: the source paraphrased the posting; `fixture_summary`: research notes only. */
  textSource: z.enum(['full_description', 'source_summary', 'fixture_summary']),
  run: RunStatusSchema,
});
export type DemoJobSummary = z.infer<typeof DemoJobSummarySchema>;
export const DemoJobListSchema = z.array(DemoJobSummarySchema);

export const DemoJobSchema = DemoJobSummarySchema.extend({
  text: z.string(),
  retrievedOn: z.string().nullable(),
  sourceLimitations: z.array(z.string()),
  freshness: FreshnessSchema,
  requirements: z.array(
    JobRequirementSchema.pick({
      skillId: true,
      requiredLevel: true,
      suggestedPriority: true,
      referenceStatus: true,
    }).extend({
      name: z.string(),
      priority: PrioritySchema,
      prioritySource: z.enum(['override', 'suggested']),
    }),
  ),
});
export type DemoJob = z.infer<typeof DemoJobSchema>;

/** Scored only from current assessments; missing or outdated analyses are never shown as 0%. */
export const DemoMatchSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('available'), match: MatchResultSchema }),
  z.object({
    availability: z.literal('unavailable'),
    reason: z.enum(['candidate_not_current', 'job_not_current', 'no_attributed_evidence']),
  }),
]);
export type DemoMatch = z.infer<typeof DemoMatchSchema>;

export const AnalysisStartSchema = z.object({ result: z.enum(['started', 'cached']) });
export type AnalysisStart = z.infer<typeof AnalysisStartSchema>;

// ---- Demo recruiting workflow: a demo identity acts as a sample candidate or employer ----

export const DemoSideSchema = z.enum(['candidate', 'employer']);
export type DemoSide = z.infer<typeof DemoSideSchema>;

export const DemoIdentityInputSchema = z.object({ kind: DemoSideSchema, key: z.string().min(1) });

/** The chosen demo identity and the counts of items waiting on it. Never a GitHub sign-in. */
export const DemoIdentitySchema = z.object({
  identity: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('candidate'),
      key: z.string(),
      name: z.string(),
      githubLogin: z.string(),
      githubUrl: z.string(),
    }),
    z.object({
      kind: z.literal('employer'),
      key: z.string(),
      name: z.string(),
      description: z.string(),
      url: z.string(),
      location: z.string().nullable(),
    }),
  ]),
  badges: z.object({
    matches: z.number().int(),
    interviews: z.number().int(),
    offers: z.number().int(),
  }),
});
export type DemoIdentity = z.infer<typeof DemoIdentitySchema>;

export const AnswerSchema = z.enum(['yes', 'maybe', 'no']);
export type Answer = z.infer<typeof AnswerSchema>;

/** Relative to the viewing identity: "needs_response" for one side is "waiting" for the other. */
export const RelationshipStageSchema = z.enum([
  'needs_response',
  'waiting',
  'discussion',
  'interview',
  'offer_shared',
  'offer_accepted',
  'offer_declined',
  'you_declined',
  'they_declined',
]);
export type RelationshipStage = z.infer<typeof RelationshipStageSchema>;

export const RelationshipSchema = z.object({
  stage: RelationshipStageSchema,
  candidateAnswer: AnswerSchema.nullable(),
  employerAnswer: AnswerSchema.nullable(),
  candidateConfirmed: z.boolean(),
  employerConfirmed: z.boolean(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * `updating`: no current result yet and a run is queued or pending. Every other non-scored state
 * names why there is no score.
 */
export const ScoreSchema = z.object({
  state: z.enum([
    'scored',
    'zero_priority',
    'updating',
    'failed',
    'outdated',
    'not_analyzed',
    'no_attributed_code',
    'profile_incomplete',
  ]),
  compatibility: z.number().nullable(),
  evidenceCoverage: z.number().nullable(),
  provisional: z.boolean(),
  /** Either side is queued or being analysed, even when an earlier result is scored. */
  pending: z.boolean(),
});
export type Score = z.infer<typeof ScoreSchema>;

const MatchPartiesSchema = z.object({
  candidate: z.object({
    key: z.string(),
    name: z.string(),
    githubLogin: z.string(),
    /** The candidate's own résumé headline; null when absent or ambiguous. */
    title: z.string().nullable(),
  }),
  job: z.object({
    id: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    employer: z.object({ id: z.string(), name: z.string() }),
  }),
});

export const MatchSummarySchema = MatchPartiesSchema.extend({
  score: ScoreSchema,
  relationship: RelationshipSchema,
  lastActivityAt: z.string().nullable(),
});
export type MatchSummary = z.infer<typeof MatchSummarySchema>;
export const MatchListSchema = z.array(MatchSummarySchema);

export const InterviewFormatSchema = z.enum(['video', 'phone', 'in_person']);
export const InterviewSchema = z.object({
  format: InterviewFormatSchema,
  lengthMinutes: z.number().int(),
  location: z.string(),
  slots: z.array(z.object({ id: z.string(), startsAt: z.string() })),
  confirmedSlotId: z.string().nullable(),
});
export type Interview = z.infer<typeof InterviewSchema>;

export const InterviewInputSchema = z
  .object({
    format: InterviewFormatSchema,
    lengthMinutes: z.number().int().min(15).max(480),
    location: z.string().trim().min(1).max(300),
    slots: z
      .array(z.string().datetime({ offset: true }))
      .min(1)
      .max(10)
      .refine((s) => new Set(s.map((t) => Date.parse(t))).size === s.length, 'Duplicate slot'),
  })
  .strict();
export type InterviewInput = z.infer<typeof InterviewInputSchema>;
export const InterviewConfirmSchema = z.object({ slotId: z.string().uuid() }).strict();

export const InterviewItemSchema = MatchSummarySchema.extend({
  interview: InterviewSchema.nullable(),
});
export const InterviewListSchema = z.array(InterviewItemSchema);
export type InterviewItem = z.infer<typeof InterviewItemSchema>;

export const ArrangementSchema = z.enum(['on_site', 'hybrid', 'remote']);
export type Arrangement = z.infer<typeof ArrangementSchema>;

export const OfferInputSchema = z
  .object({
    role: z.string().trim().min(1).max(200),
    baseSalaryCad: z.number().int().min(1).max(10_000_000),
    startDate: z.string().date(),
    arrangement: ArrangementSchema,
    note: z.string().trim().max(2000),
  })
  .strict();
export type OfferInput = z.infer<typeof OfferInputSchema>;

export const OfferSchema = MatchPartiesSchema.extend(OfferInputSchema.shape).extend({
  id: z.string(),
  status: z.enum(['draft', 'shared', 'accepted', 'declined', 'withdrawn']),
  stage: RelationshipStageSchema,
  updatedAt: z.string(),
});
export type Offer = z.infer<typeof OfferSchema>;
export const OfferListSchema = z.array(OfferSchema);

export const MatchDetailSchema = MatchSummarySchema.extend({
  match: DemoMatchSchema,
  interview: InterviewSchema.nullable(),
  /** Drafts are visible only to the employer. */
  offer: OfferSchema.nullable(),
});
export type MatchDetail = z.infer<typeof MatchDetailSchema>;

export const AnswerInputSchema = z.object({ answer: AnswerSchema }).strict();

export const MessageInputSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
export const MessageSchema = z.object({
  id: z.string(),
  authorSide: DemoSideSchema,
  body: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;
export const MessageListSchema = z.array(MessageSchema);

/** Seeker preferences are editable and never affect scores. */
export const PreferencesSchema = z
  .object({
    titles: z.array(z.string().trim().min(1).max(100)).max(10),
    locations: z.array(z.string().trim().min(1).max(100)).max(10),
    arrangements: z.array(ArrangementSchema).max(3),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;

// ---- Top matches ----

export const TOP_MATCHES = { min: 5, max: 10, default: 5 } as const;

/** Scored pairs only, highest compatibility first, at most `n` (an integer from 5 through 10). */
export function topMatches<T extends { score: Score }>(matches: T[], n: number): T[] {
  const limit = Math.min(TOP_MATCHES.max, Math.max(TOP_MATCHES.min, Math.round(n)));
  return matches
    .filter((m) => m.score.state === 'scored')
    .sort((a, b) => b.score.compatibility! - a.score.compatibility!)
    .slice(0, limit);
}

/** True while any pair waits on an analysis, scored or not, displayed or not. */
export const hasPendingWork = (matches: { score: Score }[]) => matches.some((m) => m.score.pending);
