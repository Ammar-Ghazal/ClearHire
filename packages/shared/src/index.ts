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
});
export type Me = z.infer<typeof MeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---- Skill assessments and matching ----

export { SKILL_CATALOGUE, SKILL_IDS } from './skill-catalogue.js';
export type { CatalogueCategory, CatalogueSkill } from './skill-catalogue.js';

export const SkillIdSchema = z.enum(SKILL_IDS);
export const SkillLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
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
