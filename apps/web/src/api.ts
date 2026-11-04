// Thin client for the API. In development the base is /api (proxied by Vite);
// in production set VITE_API_URL to the API's public URL.
import {
  AnalysisStartSchema,
  ApiErrorSchema,
  DemoCandidateListSchema,
  DemoCandidateSchema,
  DemoJobListSchema,
  DemoJobSchema,
  DemoIdentitySchema,
  DemoMatchSchema,
  HealthSchema,
  InterviewListSchema,
  MatchDetailSchema,
  MatchListSchema,
  MeSchema,
  JudgeProfileSchema,
  GitHubDeviceCodeSchema,
  GitHubDevicePollSchema,
  MessageListSchema,
  OfferListSchema,
  OfferSchema,
  PreferencesSchema,
  PublicRepositoriesSchema,
  RepositorySelectionSavedSchema,
  type Answer,
  type DemoIdentity,
  type DemoSide,
  type InterviewInput,
  type OfferInput,
  type Preferences,
  type AnalysisStart,
  type DemoCandidate,
  type DemoCandidateSummary,
  type DemoJob,
  type DemoJobSummary,
  type DemoMatch,
  type Health,
  type Me,
  type PublicRepository,
  type RepositorySelectionSaved,
} from '@clearhire/shared';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
    return HealthSchema.parse(await res.json());
  } catch {
    return null;
  }
}

/** Returns the signed-in user, or null when signed out. */
export async function getMe(): Promise<Me | null> {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /me failed: ${res.status}`);
  return MeSchema.parse(await res.json());
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
}

// ---- Demo screen ----

/** Carries the API's error code so the screen can show it beside the action that failed. */
export class ApiRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function request<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    ...(init.body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.body),
    }),
  });
  if (res.status === 204) return schema.parse(undefined);
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    throw new ApiRequestError(parsed.success ? parsed.data.error.code : `http_${res.status}`);
  }
  return schema.parse(json);
}

const segment = encodeURIComponent;

// ---- Signed-in account: repository choice (grading live accounts is not available yet) ----

export const startGitHubSignIn = () =>
  request('/auth/github/device', GitHubDeviceCodeSchema, { method: 'POST' });
export const pollGitHubSignIn = () =>
  request('/auth/github/device/poll', GitHubDevicePollSchema, { method: 'POST' });
export const getJudgeProfile = () => request('/me/profile', JudgeProfileSchema);
export const analyzeJudgeProfile = () =>
  request('/me/profile/analysis', AnalysisStartSchema, { method: 'POST' });

export const getMyRepositories = (): Promise<PublicRepository[]> =>
  request('/me/repositories', PublicRepositoriesSchema);

export const saveMyRepositories = (repoIds: number[]): Promise<RepositorySelectionSaved> =>
  request('/me/repositories/selection', RepositorySelectionSavedSchema, {
    method: 'PUT',
    body: { repoIds },
  });

export const getDemoCandidates = (): Promise<DemoCandidateSummary[]> =>
  request('/demo/candidates', DemoCandidateListSchema);

export const getDemoCandidate = (key: string): Promise<DemoCandidate> =>
  request(`/demo/candidates/${segment(key)}`, DemoCandidateSchema);

export const getDemoJobs = (): Promise<DemoJobSummary[]> =>
  request('/demo/jobs', DemoJobListSchema);

export const getDemoJob = (id: string): Promise<DemoJob> =>
  request(`/demo/jobs/${segment(id)}`, DemoJobSchema);

export const getDemoMatch = (candidate: string, job: string): Promise<DemoMatch> =>
  request(
    `/demo/match?candidate=${segment(candidate)}&job=${segment(job)}`,
    DemoMatchSchema,
  );

/** `regrade` runs a fresh analysis even when a saved result for the same inputs exists. */
export const startCandidateAnalysis = (key: string, regrade: boolean): Promise<AnalysisStart> =>
  request(`/demo/candidates/${segment(key)}/analysis`, AnalysisStartSchema, {
    method: 'POST',
    body: { retry: regrade, fresh: regrade },
  });

export const startJobAnalysis = (id: string, regrade: boolean): Promise<AnalysisStart> =>
  request(`/demo/jobs/${segment(id)}/analysis`, AnalysisStartSchema, {
    method: 'POST',
    body: { retry: regrade, fresh: regrade },
  });

/** A seeker's own explicit regrade: fetches the named repositories again and grades them anew. */
export const regradeCandidate = (key: string, repoIds?: number[]): Promise<AnalysisStart> =>
  request(`/demo/candidates/${segment(key)}/rerun`, AnalysisStartSchema, {
    method: 'POST',
    body: { repoIds },
  });

/** `null` resets the requirement to its suggested priority. */
export const setJobPriority = (id: string, skillId: string, priority: number | null) =>
  request(`/demo/jobs/${segment(id)}/priorities/${segment(skillId)}`, DemoJobSchema, {
    method: 'PUT',
    body: { priority },
  });

/** Resets every requirement of the posting to its suggested priority. */
export const resetJobPriorities = (id: string) =>
  request(`/demo/jobs/${segment(id)}/priorities`, DemoJobSchema, { method: 'DELETE' });

// ---- Demo identity and recruiting workflow ----

const nothing = { parse: () => undefined };

/** Returns the chosen demo identity, or null when none is chosen. */
export async function getDemoIdentity(): Promise<DemoIdentity | null> {
  try {
    return await request('/demo/identity', DemoIdentitySchema);
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'no_demo_identity') return null;
    throw err;
  }
}

export const chooseDemoIdentity = (kind: DemoSide, key: string) =>
  request('/demo/identity', DemoIdentitySchema, { method: 'POST', body: { kind, key } });

export const clearDemoIdentity = () =>
  request('/demo/identity', nothing, { method: 'DELETE' });

export const getMatches = (job?: string) =>
  request(`/demo/matches${job ? `?job=${segment(job)}` : ''}`, MatchListSchema);

const matchPath = (candidate: string, job: string) =>
  `/demo/matches/${segment(candidate)}/${segment(job)}`;

export const getMatchDetail = (candidate: string, job: string) =>
  request(matchPath(candidate, job), MatchDetailSchema);

export const answerMatch = (candidate: string, job: string, answer: Answer) =>
  request(`${matchPath(candidate, job)}/answer`, MatchDetailSchema, {
    method: 'PUT',
    body: { answer },
  });

export const confirmInterviewStage = (candidate: string, job: string) =>
  request(`${matchPath(candidate, job)}/confirm-interview`, MatchDetailSchema, { method: 'POST' });

export const getMessages = (candidate: string, job: string) =>
  request(`${matchPath(candidate, job)}/messages`, MessageListSchema);

export const postMessage = (candidate: string, job: string, body: string) =>
  request(`${matchPath(candidate, job)}/messages`, MessageListSchema, {
    method: 'POST',
    body: { body },
  });

export const getInterviews = () => request('/demo/interviews', InterviewListSchema);

export const saveInterview = (candidate: string, job: string, input: InterviewInput) =>
  request(`${matchPath(candidate, job)}/interview`, MatchDetailSchema, {
    method: 'PUT',
    body: input,
  });

export const confirmInterviewSlot = (candidate: string, job: string, slotId: string) =>
  request(`${matchPath(candidate, job)}/interview/confirm`, MatchDetailSchema, {
    method: 'POST',
    body: { slotId },
  });

export const getOffers = () => request('/demo/offers', OfferListSchema);

export const getOffer = (id: string) => request(`/demo/offers/${segment(id)}`, OfferSchema);

export const saveOfferDraft = (candidate: string, job: string, input: OfferInput) =>
  request(`${matchPath(candidate, job)}/offer`, MatchDetailSchema, { method: 'PUT', body: input });

export const offerAction = (id: string, action: 'share' | 'accept' | 'decline') =>
  request(`/demo/offers/${segment(id)}/${action}`, OfferSchema, { method: 'POST' });

export const getPreferences = () => request('/demo/profile/preferences', PreferencesSchema);

export const savePreferences = (preferences: Preferences) =>
  request('/demo/profile/preferences', PreferencesSchema, { method: 'PUT', body: preferences });
