// Demo recruiting workflow: identity, matches, answers, Discussion, interviews, offers and seeker
// preferences. Every route acts as the demo identity; every write locks the relationship row and
// checks its stage, so the UI only reflects rules enforced here. Reads never call GitHub or Muse.
import {
  AnswerInputSchema,
  DemoIdentityInputSchema,
  InterviewConfirmSchema,
  InterviewInputSchema,
  MessageInputSchema,
  OfferInputSchema,
  PreferencesSchema,
  type DemoIdentity,
  type DemoMatch,
  type DemoSide,
  type Interview,
  type InterviewItem,
  type MatchDetail,
  type MatchSummary,
  type Message,
  type Offer,
  type Preferences,
  type Score,
} from '@clearhire/shared';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  demoCandidates,
  demoEmployers,
  demoInterviews,
  demoInterviewSlots,
  demoJobs,
  demoMessages,
  demoOffers,
  demoPreferences,
  demoRelationships,
} from '../db/schema.js';
import {
  clearDemoIdentity,
  currentDemoIdentity,
  identityExists,
  setDemoIdentity,
  type DemoIdentityRef,
} from '../lib/demo-identity.js';
import {
  candidateState,
  jobState,
  matchFromStates,
  priorityOverrides,
  type CandidateRow,
  type CandidateState,
  type JobRow,
  type JobState,
} from '../lib/demo-results.js';
import {
  canAnswer,
  MESSAGE_STAGES,
  NO_RELATIONSHIP,
  relationshipStage,
  stageFor,
  type RelationshipFacts,
} from '../lib/relationship.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RelationshipRow = typeof demoRelationships.$inferSelect;
type OfferRow = typeof demoOffers.$inferSelect;

const send = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** Thrown inside a transaction so a refused write rolls back everything it started. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function act<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Refusal) return send(reply, err.status, err.code, err.message);
    throw err;
  }
}

async function requireIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<DemoIdentityRef | null> {
  const identity = await currentDemoIdentity(request);
  if (!identity) send(reply, 401, 'no_demo_identity', 'Choose a demo identity first');
  return identity;
}

// ---- Pairs: every non-organization candidate × in-scope posting visible to the identity ----

interface Pair {
  candidate: { key: string; name: string; githubLogin: string };
  job: { id: string; title: string; location: string | null; employer: { id: string; name: string } };
}

const pairKey = (candidateKey: string, jobId: string) => `${candidateKey}\n${jobId}`;

async function pairsFor(
  identity: DemoIdentityRef,
  only: { candidate?: string; job?: string } = {},
): Promise<Pair[]> {
  const mine = (side: DemoSide, wanted: string | undefined) =>
    identity.kind === side && wanted !== undefined && wanted !== identity.key;
  if (mine('candidate', only.candidate)) return [];
  const candidateKey = identity.kind === 'candidate' ? identity.key : only.candidate;
  const where = (...conditions: (SQL | undefined)[]) => and(...conditions);
  const candidates = await db
    .select({
      key: demoCandidates.key,
      name: demoCandidates.name,
      githubLogin: demoCandidates.githubLogin,
    })
    .from(demoCandidates)
    .where(
      where(
        eq(demoCandidates.organization, false),
        candidateKey === undefined ? undefined : eq(demoCandidates.key, candidateKey),
      ),
    )
    .orderBy(demoCandidates.name);
  const jobs = await db
    .select({
      id: demoJobs.id,
      title: demoJobs.title,
      location: demoJobs.location,
      employer: { id: demoEmployers.id, name: demoEmployers.name },
    })
    .from(demoJobs)
    .innerJoin(demoEmployers, eq(demoEmployers.id, demoJobs.employerId))
    .where(
      where(
        eq(demoJobs.inScope, true),
        identity.kind === 'employer' ? eq(demoJobs.employerId, identity.key) : undefined,
        only.job === undefined ? undefined : eq(demoJobs.id, only.job),
      ),
    )
    .orderBy(demoJobs.id);
  return jobs.flatMap((job) => candidates.map((candidate) => ({ candidate, job })));
}

// ---- Workflow state of those pairs ----

interface Workflow {
  rel: RelationshipRow;
  offer: OfferRow | null;
  interview: Interview | null;
}

const factsOf = (rel: RelationshipRow | undefined, offer: OfferRow | null): RelationshipFacts =>
  rel
    ? {
        candidateAnswer: rel.candidateAnswer,
        employerAnswer: rel.employerAnswer,
        candidateConfirmed: rel.candidateConfirmedAt !== null,
        employerConfirmed: rel.employerConfirmedAt !== null,
        offerStatus: offer?.status ?? null,
      }
    : NO_RELATIONSHIP;

async function workflowFor(identity: DemoIdentityRef): Promise<Map<string, Workflow>> {
  const rows = await db
    .select({ rel: demoRelationships, offer: demoOffers, interview: demoInterviews })
    .from(demoRelationships)
    .innerJoin(demoJobs, eq(demoJobs.id, demoRelationships.jobId))
    .leftJoin(
      demoOffers,
      and(
        eq(demoOffers.candidateKey, demoRelationships.candidateKey),
        eq(demoOffers.jobId, demoRelationships.jobId),
      ),
    )
    .leftJoin(
      demoInterviews,
      and(
        eq(demoInterviews.candidateKey, demoRelationships.candidateKey),
        eq(demoInterviews.jobId, demoRelationships.jobId),
      ),
    )
    .where(
      identity.kind === 'candidate'
        ? eq(demoRelationships.candidateKey, identity.key)
        : eq(demoJobs.employerId, identity.key),
    );
  const withInterview = rows.filter((r) => r.interview);
  const slots = withInterview.length
    ? await db
        .select()
        .from(demoInterviewSlots)
        .where(
          and(
            inArray(demoInterviewSlots.candidateKey, withInterview.map((r) => r.rel.candidateKey)),
            inArray(demoInterviewSlots.jobId, withInterview.map((r) => r.rel.jobId)),
          ),
        )
        .orderBy(asc(demoInterviewSlots.startsAt))
    : [];
  return new Map(
    rows.map(({ rel, offer, interview }) => [
      pairKey(rel.candidateKey, rel.jobId),
      {
        rel,
        offer,
        interview: interview && {
          format: interview.format,
          lengthMinutes: interview.lengthMinutes,
          location: interview.location,
          confirmedSlotId: interview.confirmedSlotId,
          slots: slots
            .filter((s) => s.candidateKey === rel.candidateKey && s.jobId === rel.jobId)
            .map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString() })),
        },
      },
    ]),
  );
}

// ---- Scores: computed from current analyses only, one state lookup per subject ----

type Subject<Row, State> = { row: Row; state: State };

function scoreOf(
  match: DemoMatch,
  c: Subject<CandidateRow, CandidateState>,
  j: Subject<JobRow, JobState>,
): Score {
  const none = { compatibility: null, evidenceCoverage: null, provisional: false };
  if (match.availability === 'available') {
    const m = match.match;
    // Pairs are in scope, so an unscored match here is one whose priorities are all 0.
    return m.status === 'scored'
      ? {
          state: 'scored',
          compatibility: m.compatibility,
          evidenceCoverage: m.evidenceCoverage,
          provisional: m.provisional,
        }
      : { state: 'zero_priority', ...none };
  }
  if (match.reason === 'no_attributed_evidence') return { state: 'no_attributed_code', ...none };
  const side = match.reason === 'candidate_not_current' ? c : j;
  const fresh = side.state.freshness.state;
  const state =
    side.row.runStatus === 'pending' || fresh === 'pending'
      ? 'updating'
      : side.row.runStatus === 'failed' || fresh === 'failed'
        ? 'failed'
        : fresh === 'outdated'
          ? 'outdated'
          : 'not_analyzed';
  return { state, ...none };
}

async function matchesFor(pairs: Pair[]): Promise<Map<string, { match: DemoMatch; score: Score }>> {
  const candidateKeys = [...new Set(pairs.map((p) => p.candidate.key))];
  const jobIds = [...new Set(pairs.map((p) => p.job.id))];
  if (pairs.length === 0) return new Map();
  const [candidateRows, jobRows] = await Promise.all([
    db.select().from(demoCandidates).where(inArray(demoCandidates.key, candidateKeys)),
    db.select().from(demoJobs).where(inArray(demoJobs.id, jobIds)),
  ]);
  const candidates = new Map(
    await Promise.all(
      candidateRows.map(async (row) => [row.key, { row, state: await candidateState(row) }] as const),
    ),
  );
  const jobs = new Map(
    await Promise.all(
      jobRows.map(
        async (row) =>
          [row.id, { row, state: await jobState(row), overrides: await priorityOverrides(row.id) }] as const,
      ),
    ),
  );
  return new Map(
    pairs.map((p) => {
      const c = candidates.get(p.candidate.key)!;
      const j = jobs.get(p.job.id)!;
      const match = matchFromStates(c.state, j.state, j.overrides);
      return [pairKey(p.candidate.key, p.job.id), { match, score: scoreOf(match, c, j) }];
    }),
  );
}

// ---- Views ----

function summaryOf(pair: Pair, wf: Workflow | undefined, side: DemoSide, score: Score): MatchSummary {
  const facts = factsOf(wf?.rel, wf?.offer ?? null);
  return {
    ...pair,
    score,
    relationship: {
      stage: stageFor(facts, side),
      candidateAnswer: facts.candidateAnswer,
      employerAnswer: facts.employerAnswer,
      candidateConfirmed: facts.candidateConfirmed,
      employerConfirmed: facts.employerConfirmed,
    },
    lastActivityAt: wf?.rel.updatedAt.toISOString() ?? null,
  };
}

function offerOf(pair: Pair, wf: Workflow, side: DemoSide): Offer | null {
  const o = wf.offer;
  if (!o || (o.status === 'draft' && side !== 'employer')) return null;
  return {
    ...pair,
    id: o.id,
    role: o.role,
    baseSalaryCad: o.baseSalaryCad,
    startDate: o.startDate,
    arrangement: o.arrangement,
    note: o.note,
    status: o.status,
    stage: stageFor(factsOf(wf.rel, o), side),
    updatedAt: o.updatedAt.toISOString(),
  };
}

async function detailOf(
  identity: DemoIdentityRef,
  candidateKey: string,
  jobId: string,
): Promise<MatchDetail | null> {
  const [pair] = await pairsFor(identity, { candidate: candidateKey, job: jobId });
  if (!pair) return null;
  const key = pairKey(candidateKey, jobId);
  const [workflow, matches] = await Promise.all([workflowFor(identity), matchesFor([pair])]);
  const wf = workflow.get(key);
  const { match, score } = matches.get(key)!;
  return {
    ...summaryOf(pair, wf, identity.kind, score),
    match,
    interview: wf?.interview ?? null,
    offer: wf ? offerOf(pair, wf, identity.kind) : null,
  };
}

async function identityView(identity: DemoIdentityRef): Promise<DemoIdentity> {
  const [pairs, workflow] = await Promise.all([pairsFor(identity), workflowFor(identity)]);
  const badges = { matches: 0, interviews: 0, offers: 0 };
  for (const pair of pairs) {
    const wf = workflow.get(pairKey(pair.candidate.key, pair.job.id));
    const stage = stageFor(factsOf(wf?.rel, wf?.offer ?? null), identity.kind);
    if (stage === 'needs_response') badges.matches++;
    if (stage === 'interview') {
      const waiting =
        identity.kind === 'employer' ? !wf?.interview : wf?.interview?.confirmedSlotId === null;
      if (waiting) badges.interviews++;
    }
    if (stage === 'offer_shared' && identity.kind === 'candidate') badges.offers++;
  }
  if (identity.kind === 'candidate') {
    const [c] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, identity.key));
    return {
      identity: {
        kind: 'candidate',
        key: c!.key,
        name: c!.name,
        githubLogin: c!.githubLogin,
        githubUrl: c!.githubUrl,
      },
      badges,
    };
  }
  const [e] = await db.select().from(demoEmployers).where(eq(demoEmployers.id, identity.key));
  return {
    identity: {
      kind: 'employer',
      key: e!.id,
      name: e!.name,
      description: e!.description,
      url: e!.url,
      location: e!.location,
    },
    badges,
  };
}

// ---- Writes ----

const relationshipWhere = (candidateKey: string, jobId: string) =>
  and(eq(demoRelationships.candidateKey, candidateKey), eq(demoRelationships.jobId, jobId));

/** Creates the relationship row if needed and locks it: one writer per pair at a time. */
async function lockRelationship(tx: Tx, candidateKey: string, jobId: string) {
  await tx.insert(demoRelationships).values({ candidateKey, jobId }).onConflictDoNothing();
  const [rel] = await tx
    .select()
    .from(demoRelationships)
    .where(relationshipWhere(candidateKey, jobId))
    .for('update');
  const [offer] = await tx
    .select()
    .from(demoOffers)
    .where(and(eq(demoOffers.candidateKey, candidateKey), eq(demoOffers.jobId, jobId)));
  const facts = factsOf(rel, offer ?? null);
  return { offer: offer ?? null, facts, stage: relationshipStage(facts) };
}

const touch = (tx: Tx, candidateKey: string, jobId: string, now = new Date()) =>
  tx
    .update(demoRelationships)
    .set({ updatedAt: now })
    .where(relationshipWhere(candidateKey, jobId));

const requireSide = (identity: DemoIdentityRef, side: DemoSide) => {
  if (identity.kind !== side) {
    throw new Refusal(403, 'wrong_side', `Only the ${side} can do this`);
  }
};

const MatchParams = z.object({ candidate: z.string().min(1), job: z.string().min(1) });
const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ job: z.string().min(1).optional() });

export async function demoWorkflowRoutes(app: FastifyInstance) {
  /** Resolves identity and match params, and refuses pairs the identity is not a party to. */
  async function party(request: FastifyRequest, reply: FastifyReply) {
    const identity = await requireIdentity(request, reply);
    if (!identity) return null;
    const params = MatchParams.safeParse(request.params);
    if (!params.success) {
      send(reply, 400, 'invalid_input', 'Invalid match');
      return null;
    }
    const { candidate, job } = params.data;
    if ((await pairsFor(identity, { candidate, job })).length === 0) {
      send(reply, 404, 'not_found', 'No match for this demo identity');
      return null;
    }
    return { identity, candidate, job };
  }

  /** Finds an offer the identity may see. */
  async function visibleOffer(request: FastifyRequest, reply: FastifyReply) {
    const identity = await requireIdentity(request, reply);
    if (!identity) return null;
    const params = IdParams.safeParse(request.params);
    if (!params.success) {
      send(reply, 400, 'invalid_input', 'Invalid offer id');
      return null;
    }
    const [row] = await db.select().from(demoOffers).where(eq(demoOffers.id, params.data.id));
    const [pair] = row
      ? await pairsFor(identity, { candidate: row.candidateKey, job: row.jobId })
      : [];
    const wf = pair && (await workflowFor(identity)).get(pairKey(row!.candidateKey, row!.jobId));
    const offer = pair && wf ? offerOf(pair, wf, identity.kind) : null;
    if (!offer) {
      send(reply, 404, 'not_found', 'No offer for this demo identity');
      return null;
    }
    return { identity, offer, row: row! };
  }

  // Identity

  app.get('/demo/identity', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    return identity ? identityView(identity) : reply;
  });

  app.post('/demo/identity', async (request, reply) => {
    const body = DemoIdentityInputSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Pass kind and key');
    if (!(await identityExists(body.data))) {
      return send(reply, 404, 'not_found', 'No demo identity with this key');
    }
    setDemoIdentity(reply, body.data);
    return identityView(body.data);
  });

  app.delete('/demo/identity', async (_request, reply) => {
    clearDemoIdentity(reply);
    return reply.code(204).send();
  });

  // Matches

  app.get('/demo/matches', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    if (!identity) return reply;
    const query = ListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, 'invalid_input', 'Invalid filter');
    const pairs = await pairsFor(identity, { job: query.data.job });
    const [workflow, matches] = await Promise.all([workflowFor(identity), matchesFor(pairs)]);
    return pairs.map((p) => {
      const key = pairKey(p.candidate.key, p.job.id);
      return summaryOf(p, workflow.get(key), identity.kind, matches.get(key)!.score);
    });
  });

  app.get('/demo/matches/:candidate/:job', async (request, reply) => {
    const p = await party(request, reply);
    return p ? detailOf(p.identity, p.candidate, p.job) : reply;
  });

  app.put('/demo/matches/:candidate/:job/answer', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    const body = AnswerInputSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Answer yes, maybe or no');
    const { answer } = body.data;
    return act(reply, async () => {
      await db.transaction(async (tx) => {
        const { offer, facts } = await lockRelationship(tx, p.candidate, p.job);
        if (!canAnswer(facts, p.identity.kind, answer)) {
          throw new Refusal(409, 'invalid_transition', 'This answer can no longer be changed');
        }
        const now = new Date();
        await tx
          .update(demoRelationships)
          .set(
            p.identity.kind === 'candidate'
              ? { candidateAnswer: answer, updatedAt: now }
              : { employerAnswer: answer, updatedAt: now },
          )
          .where(relationshipWhere(p.candidate, p.job));
        // No while an offer is shared ends it: the employer withdraws, the candidate declines.
        if (answer === 'no' && offer?.status === 'shared') {
          await tx
            .update(demoOffers)
            .set({
              status: p.identity.kind === 'employer' ? 'withdrawn' : 'declined',
              updatedAt: now,
            })
            .where(eq(demoOffers.id, offer.id));
        }
      });
      return detailOf(p.identity, p.candidate, p.job);
    });
  });

  app.post('/demo/matches/:candidate/:job/confirm-interview', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    return act(reply, async () => {
      await db.transaction(async (tx) => {
        const { stage } = await lockRelationship(tx, p.candidate, p.job);
        if (stage !== 'discussion') {
          throw new Refusal(409, 'invalid_stage', 'Interviews are confirmed from Discussion');
        }
        const column =
          p.identity.kind === 'candidate'
            ? demoRelationships.candidateConfirmedAt
            : demoRelationships.employerConfirmedAt;
        const now = new Date();
        await tx
          .update(demoRelationships)
          .set(
            p.identity.kind === 'candidate'
              ? { candidateConfirmedAt: now, updatedAt: now }
              : { employerConfirmedAt: now, updatedAt: now },
          )
          .where(and(relationshipWhere(p.candidate, p.job), isNull(column)));
      });
      return detailOf(p.identity, p.candidate, p.job);
    });
  });

  // Discussion

  const messagesOf = async (candidateKey: string, jobId: string): Promise<Message[]> =>
    (
      await db
        .select()
        .from(demoMessages)
        .where(and(eq(demoMessages.candidateKey, candidateKey), eq(demoMessages.jobId, jobId)))
        .orderBy(asc(demoMessages.createdAt))
    ).map((m) => ({
      id: m.id,
      authorSide: m.authorSide,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    }));

  app.get('/demo/matches/:candidate/:job/messages', async (request, reply) => {
    const p = await party(request, reply);
    return p ? messagesOf(p.candidate, p.job) : reply;
  });

  app.post('/demo/matches/:candidate/:job/messages', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    const body = MessageInputSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Write a message');
    return act(reply, async () => {
      await db.transaction(async (tx) => {
        const { stage } = await lockRelationship(tx, p.candidate, p.job);
        if (!MESSAGE_STAGES.includes(stage)) {
          throw new Refusal(409, 'discussion_closed', 'Discussion is not open for this match');
        }
        const now = new Date();
        await tx.insert(demoMessages).values({
          candidateKey: p.candidate,
          jobId: p.job,
          authorSide: p.identity.kind,
          body: body.data.body,
          createdAt: now,
        });
        await touch(tx, p.candidate, p.job, now);
      });
      return messagesOf(p.candidate, p.job);
    });
  });

  // Interviews

  app.get('/demo/interviews', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    if (!identity) return reply;
    const workflow = await workflowFor(identity);
    const pairs = (await pairsFor(identity)).filter((p) => {
      const wf = workflow.get(pairKey(p.candidate.key, p.job.id));
      return wf && (wf.interview || relationshipStage(factsOf(wf.rel, wf.offer)) === 'interview');
    });
    const matches = await matchesFor(pairs);
    return pairs.map((p): InterviewItem => {
      const key = pairKey(p.candidate.key, p.job.id);
      const wf = workflow.get(key);
      return {
        ...summaryOf(p, wf, identity.kind, matches.get(key)!.score),
        interview: wf?.interview ?? null,
      };
    });
  });

  app.put('/demo/matches/:candidate/:job/interview', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    const body = InterviewInputSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Invalid interview details');
    return act(reply, async () => {
      requireSide(p.identity, 'employer');
      await db.transaction(async (tx) => {
        const { stage } = await lockRelationship(tx, p.candidate, p.job);
        if (stage !== 'interview') {
          throw new Refusal(409, 'invalid_stage', 'This match is not at the Interview stage');
        }
        const ref = { candidateKey: p.candidate, jobId: p.job };
        const [existing] = await tx
          .select()
          .from(demoInterviews)
          .where(and(eq(demoInterviews.candidateKey, p.candidate), eq(demoInterviews.jobId, p.job)));
        if (existing?.confirmedSlotId) {
          throw new Refusal(409, 'interview_confirmed', 'The candidate already confirmed a time');
        }
        const { slots, ...details } = body.data;
        const now = new Date();
        await tx
          .insert(demoInterviews)
          .values({ ...ref, ...details, updatedAt: now })
          .onConflictDoUpdate({
            target: [demoInterviews.candidateKey, demoInterviews.jobId],
            set: { ...details, updatedAt: now },
          });
        await tx
          .delete(demoInterviewSlots)
          .where(
            and(eq(demoInterviewSlots.candidateKey, p.candidate), eq(demoInterviewSlots.jobId, p.job)),
          );
        await tx
          .insert(demoInterviewSlots)
          .values(slots.map((startsAt) => ({ ...ref, startsAt: new Date(startsAt) })));
        await touch(tx, p.candidate, p.job, now);
      });
      return detailOf(p.identity, p.candidate, p.job);
    });
  });

  app.post('/demo/matches/:candidate/:job/interview/confirm', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    const body = InterviewConfirmSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Pick one time');
    return act(reply, async () => {
      requireSide(p.identity, 'candidate');
      await db.transaction(async (tx) => {
        const { stage } = await lockRelationship(tx, p.candidate, p.job);
        if (stage !== 'interview') {
          throw new Refusal(409, 'invalid_stage', 'This match is not at the Interview stage');
        }
        const [slot] = await tx
          .select()
          .from(demoInterviewSlots)
          .where(
            and(
              eq(demoInterviewSlots.id, body.data.slotId),
              eq(demoInterviewSlots.candidateKey, p.candidate),
              eq(demoInterviewSlots.jobId, p.job),
            ),
          );
        if (!slot) throw new Refusal(404, 'not_found', 'This time is no longer offered');
        const now = new Date();
        const confirmed = await tx
          .update(demoInterviews)
          .set({ confirmedSlotId: slot.id, updatedAt: now })
          .where(
            and(
              eq(demoInterviews.candidateKey, p.candidate),
              eq(demoInterviews.jobId, p.job),
              isNull(demoInterviews.confirmedSlotId),
            ),
          )
          .returning();
        if (confirmed.length === 0) {
          throw new Refusal(409, 'interview_confirmed', 'A time is already confirmed');
        }
        await touch(tx, p.candidate, p.job, now);
      });
      return detailOf(p.identity, p.candidate, p.job);
    });
  });

  // Offers

  app.get('/demo/offers', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    if (!identity) return reply;
    const [pairs, workflow] = await Promise.all([pairsFor(identity), workflowFor(identity)]);
    return pairs
      .flatMap((p) => {
        const wf = workflow.get(pairKey(p.candidate.key, p.job.id));
        const offer = wf && offerOf(p, wf, identity.kind);
        return offer ? [offer] : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });

  app.get('/demo/offers/:id', async (request, reply) => {
    const found = await visibleOffer(request, reply);
    return found ? found.offer : reply;
  });

  app.put('/demo/matches/:candidate/:job/offer', async (request, reply) => {
    const p = await party(request, reply);
    if (!p) return reply;
    const body = OfferInputSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Invalid offer terms');
    return act(reply, async () => {
      requireSide(p.identity, 'employer');
      await db.transaction(async (tx) => {
        const { offer, stage } = await lockRelationship(tx, p.candidate, p.job);
        if (stage !== 'interview') {
          throw new Refusal(409, 'invalid_stage', 'Offers are drafted at the Interview stage');
        }
        if (offer && offer.status !== 'draft') {
          throw new Refusal(409, 'offer_frozen', 'A shared offer cannot be changed');
        }
        const now = new Date();
        await tx
          .insert(demoOffers)
          .values({ candidateKey: p.candidate, jobId: p.job, ...body.data, updatedAt: now })
          .onConflictDoUpdate({
            target: [demoOffers.candidateKey, demoOffers.jobId],
            set: { ...body.data, updatedAt: now },
          });
      });
      return detailOf(p.identity, p.candidate, p.job);
    });
  });

  const offerAction = (
    path: string,
    side: DemoSide,
    from: { status: 'draft' | 'shared'; stage: 'interview' | 'offer_shared' },
    to: 'shared' | 'accepted' | 'declined',
  ) =>
    app.post(path, async (request, reply) => {
      const found = await visibleOffer(request, reply);
      if (!found) return reply;
      const { identity, row } = found;
      return act(reply, async () => {
        requireSide(identity, side);
        await db.transaction(async (tx) => {
          const { offer, stage } = await lockRelationship(tx, row.candidateKey, row.jobId);
          if (offer?.status !== from.status || stage !== from.stage) {
            throw new Refusal(409, 'invalid_stage', 'This offer can no longer be changed');
          }
          const now = new Date();
          await tx
            .update(demoOffers)
            .set({ status: to, updatedAt: now })
            .where(eq(demoOffers.id, offer.id));
          await touch(tx, row.candidateKey, row.jobId, now);
        });
        return (await visibleOffer(request, reply))?.offer ?? reply;
      });
    });

  offerAction('/demo/offers/:id/share', 'employer', { status: 'draft', stage: 'interview' }, 'shared');
  offerAction(
    '/demo/offers/:id/accept',
    'candidate',
    { status: 'shared', stage: 'offer_shared' },
    'accepted',
  );
  offerAction(
    '/demo/offers/:id/decline',
    'candidate',
    { status: 'shared', stage: 'offer_shared' },
    'declined',
  );

  // Seeker preferences

  app.get('/demo/profile/preferences', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    if (!identity) return reply;
    if (identity.kind !== 'candidate') return send(reply, 403, 'wrong_side', 'Seekers only');
    const [row] = await db
      .select()
      .from(demoPreferences)
      .where(eq(demoPreferences.candidateKey, identity.key));
    const body: Preferences = row
      ? { titles: row.titles, locations: row.locations, arrangements: row.arrangements }
      : { titles: [], locations: [], arrangements: [] };
    return body;
  });

  app.put('/demo/profile/preferences', async (request, reply) => {
    const identity = await requireIdentity(request, reply);
    if (!identity) return reply;
    if (identity.kind !== 'candidate') return send(reply, 403, 'wrong_side', 'Seekers only');
    const body = PreferencesSchema.safeParse(request.body);
    if (!body.success) return send(reply, 400, 'invalid_input', 'Invalid preferences');
    const values = { ...body.data, updatedAt: new Date() };
    await db
      .insert(demoPreferences)
      .values({ candidateKey: identity.key, ...values })
      .onConflictDoUpdate({ target: demoPreferences.candidateKey, set: values });
    return body.data;
  });
}
