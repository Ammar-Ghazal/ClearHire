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
  textSource: z.enum(['full_description', 'fixture_summary']),
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
export const RunStatusSchema = z.object({
  status: z.enum(['idle', 'pending', 'failed']),
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
    'not_prepared',
    'not_applicable',
    'model_not_configured',
    'input_error',
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
    'not_prepared',
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
  /** Unavailable repositories whose failure was transient; an explicit retry re-fetches them. */
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
  }),
  location: z.string().nullable(),
  sourceUrl: z.string(),
  sourceChecked: z.string().nullable(),
  inScope: z.boolean(),
  textSource: z.enum(['full_description', 'fixture_summary']),
  run: RunStatusSchema,
});
export type DemoJobSummary = z.infer<typeof DemoJobSummarySchema>;
export const DemoJobListSchema = z.array(DemoJobSummarySchema);

export const DemoJobSchema = DemoJobSummarySchema.extend({
  text: z.string(),
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
