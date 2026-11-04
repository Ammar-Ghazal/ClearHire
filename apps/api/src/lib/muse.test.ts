import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDataUse,
  callMuse,
  candidateBody,
  CandidateOutputSchema,
  CANDIDATE_MAX_COMPLETION_TOKENS,
  CONTEXT_WINDOW,
  costMicroUsd,
  countInputTokens,
  countTokens,
  COUNT_ATTEMPTS,
  createRateLimiter,
  DEFAULT_INPUT_TOKEN_CEILING,
  MUSE_RATE_LIMITS,
  jobBody,
  JobOutputSchema,
  MuseError,
  MUSE_MAX_ATTEMPTS,
  reservationMicroUsd,
  estimateTokens,
  type AttemptSettlement,
  type MuseLedger,
} from './muse.js';

const KEY = 'sk-secret-sentinel-key';
const CONFIG = { apiKey: KEY, baseUrl: 'https://muse.test/v1' };
const OUTPUT = {
  in_scope: true,
  out_of_scope_reason: null,
  requirements: [
    { skill_id: 'unit-testing', required_level: 2, suggested_priority: 3, refs: ['j1'] },
  ],
  eligibility_constraints: [],
  supporting_tags: ['TypeScript'],
};
const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  prompt_tokens_details: { cached_tokens: 400 },
  completion_tokens_details: { reasoning_tokens: 50 },
};

function completion(
  content: unknown,
  { finish = 'stop', usage = USAGE as unknown, refusal = null as string | null } = {},
) {
  return new Response(
    JSON.stringify({
      id: 'resp-1',
      choices: [{ finish_reason: finish, message: { content: JSON.stringify(content), refusal } }],
      ...(usage !== null && { usage }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const failure = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: 'no' } }), { status, headers });

function memoryLedger() {
  const settlements: AttemptSettlement[] = [];
  const reservations: number[] = [];
  const ledger: MuseLedger = {
    reserve: async (_attempt, reserved) => {
      reservations.push(reserved);
      return String(reservations.length);
    },
    settle: async (_id, s) => {
      settlements.push(s);
    },
  };
  return { ledger, settlements, reservations };
}

const body = jobBody('muse-spark-1.3', {
  title: 'Engineer',
  text: 'Write tests in TypeScript\nShip code',
  textSource: 'fixture_summary',
});

async function run(responses: (Response | Error)[], schema: ZodType<unknown> = JobOutputSchema) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  // A virtual clock: sleeping advances it, so limiter waits never take real time.
  let now = 0;
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const limiter = createRateLimiter(MUSE_RATE_LIMITS, () => now, sleep);
  const memory = memoryLedger();
  const result = callMuse({
    config: CONFIG,
    body,
    schema,
    timeoutMs: 1000,
    ledger: memory.ledger,
    limiter,
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
  });
  return { result, fetchMock, sleep, limiter, ...memory };
}

describe('pricing and data use', () => {
  const usage = {
    promptTokens: 1_000_000,
    cachedTokens: 200_000,
    completionTokens: 100_000,
    reasoningTokens: 0,
  };

  it('prices each model with its own rates', () => {
    expect(costMicroUsd('muse-spark-1.3', usage)).toBe(
      800_000 * 1.25 + 200_000 * 0.15 + 100_000 * 4.25,
    );
    expect(costMicroUsd('muse-spark-1.3-contributor', usage)).toBe(80_000 + 400 + 20_000);
    expect(reservationMicroUsd('muse-spark-1.3', 1000, 100)).toBe(
      Math.ceil(1000 * 1.25 + 100 * 4.25),
    );
  });

  it('allows Contributor mode only for approved public demo data', () => {
    expect(() =>
      assertDataUse('muse-spark-1.3-contributor', ['approved_public_demo', 'restricted']),
    ).toThrow(expect.objectContaining({ code: 'contributor_not_permitted' }));
    expect(() =>
      assertDataUse('muse-spark-1.3-contributor', ['approved_public_demo']),
    ).not.toThrow();
    expect(() => assertDataUse('muse-spark-1.3', ['restricted'])).not.toThrow();
  });
});

describe('request bodies', () => {
  it('uses strict schemas, bounded output and the same catalogue prefix for both tasks', () => {
    const candidate = candidateBody('muse-spark-1.3-contributor', '<repo></repo>', 'Resume text');
    expect(candidate).toMatchObject({
      model: 'muse-spark-1.3-contributor',
      max_completion_tokens: 32_000,
      reasoning_effort: 'low',
      store: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(body.max_completion_tokens).toBe(8_000);
    expect(candidate.messages[0]).toEqual(body.messages[0]);
    expect(candidate).not.toHaveProperty('seed');
    expect(candidate).not.toHaveProperty('temperature');
    expect(body.messages[2]!.content).toContain('j1: Write tests in TypeScript\nj2: Ship code');
    expect(estimateTokens(candidate)).toBe(Math.ceil(JSON.stringify(candidate).length / 3));
  });
});

describe('callMuse', () => {
  const skill = {
    skill_id: 'unit-testing',
    level: 1,
    confidence: 'high',
    justification: 'Tests',
    evidence_refs: ['a1'],
    supporting_tags: [],
  };
  const duplicate = { repositories: [], skills: [skill, skill] };
  const corrected = { repositories: [], skills: [skill] };

  it('resends a duplicate-skill answer, waiving the budget charge of the resent attempt', async () => {
    const { result, fetchMock, settlements } = await run(
      [completion(duplicate), completion(corrected)],
      CandidateOutputSchema,
    );
    await expect(result).resolves.toMatchObject({ data: corrected });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settlements[0]).toMatchObject({ errorCode: 'duplicate_skill_ids', waiveBudgetCharge: true });
    expect(settlements[1]).not.toHaveProperty('waiveBudgetCharge');
  });

  it('gives up after three attempts, charging only the last to the budget', async () => {
    const { result, fetchMock, settlements } = await run(
      Array.from({ length: 4 }, () => completion(duplicate)),
      CandidateOutputSchema,
    );
    await expect(result).rejects.toMatchObject({ code: 'duplicate_skill_ids' });
    expect(MUSE_MAX_ATTEMPTS).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(settlements.map((s) => s.waiveBudgetCharge ?? false)).toEqual([true, true, false]);
  });

  it('returns validated output and settles at the actual usage cost', async () => {
    const { result, fetchMock, settlements } = await run([completion(OUTPUT)]);
    await expect(result).resolves.toMatchObject({ data: OUTPUT, responseId: 'resp-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(settlements).toEqual([
      expect.objectContaining({
        settlement: 'settled',
        costSource: 'usage',
        costMicroUsd: costMicroUsd('muse-spark-1.3', {
          promptTokens: 1000,
          cachedTokens: 400,
          completionTokens: 200,
          reasoningTokens: 50,
        }),
      }),
    ]);
  });

  it('retries one 429 after Retry-After, accounting for each attempt separately', async () => {
    const { result, fetchMock, sleep, settlements, reservations } = await run([
      failure(429, { 'retry-after': '1' }),
      completion(OUTPUT),
    ]);
    await expect(result).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(reservations).toHaveLength(2);
    expect(settlements.map((s) => s.settlement)).toEqual(['released', 'settled']);
  });

  it('stops after three attempts', async () => {
    const { result, fetchMock } = await run([
      failure(429),
      failure(429),
      failure(429),
      completion(OUTPUT),
    ]);
    await expect(result).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails fast when Retry-After exceeds the limit and keeps a 503 charge as ambiguous', async () => {
    const { result, fetchMock, settlements } = await run([failure(503, { 'retry-after': '60' })]);
    await expect(result).rejects.toMatchObject({ code: 'unavailable', retryAfterMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settlements[0]).toMatchObject({ settlement: 'ambiguous', costSource: 'reservation' });
  });

  const timeout = () => Object.assign(new Error('t'), { name: 'TimeoutError' });
  it.each([
    ['a timeout', timeout, 'timeout', 'ambiguous'],
    ['a network failure', () => new TypeError('fetch failed'), 'network', 'ambiguous'],
    ['HTTP 408', () => failure(408), 'timeout', 'ambiguous'],
    ['HTTP 504', () => failure(504), 'unavailable', 'ambiguous'],
    ['truncated output', () => completion(OUTPUT, { finish: 'length' }), 'truncated', 'settled'],
    ['schema-invalid output', () => completion({ in_scope: 'yes' }), 'invalid_output', 'settled'],
    ['a missing message', () => completion(OUTPUT, { finish: 'tool_calls' }), 'invalid_output', 'settled'],
    ['an unreadable body', () => new Response('<html>', { status: 200 }), 'invalid_output', 'settled'],
  ] as const)('resends after %s, up to three attempts', async (_label, make, code, settlement) => {
    const recovered = await run([make(), completion(OUTPUT)]);
    await expect(recovered.result).resolves.toMatchObject({ data: OUTPUT });
    expect(recovered.fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered.settlements[0]).toMatchObject({ settlement, waiveBudgetCharge: true });

    const failed = await run([make(), make(), make(), completion(OUTPUT)]);
    await expect(failed.result).rejects.toMatchObject({ code });
    expect(failed.fetchMock).toHaveBeenCalledTimes(3);
    expect(failed.settlements.at(-1)).not.toHaveProperty('waiveBudgetCharge');
  });

  it.each([
    ['HTTP 400', failure(400), 'bad_request', 'released'],
    ['HTTP 401', failure(401), 'auth', 'released'],
    ['a refusal', completion(null, { refusal: 'No' }), 'refused', 'settled'],
  ])('never resends after %s', async (_label, response, code, settlement) => {
    const { result, fetchMock, settlements } = await run([response, completion(OUTPUT)]);
    await expect(result).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settlements).toEqual([expect.objectContaining({ settlement })]);
  });

  it('charges the full reservation when a successful response omits usage', async () => {
    const { result, settlements, reservations } = await run([completion(OUTPUT, { usage: null })]);
    await expect(result).resolves.toBeDefined();
    expect(settlements[0]).toMatchObject({
      costSource: 'reservation',
      costMicroUsd: reservations[0],
    });
  });

  it('keeps the key and request text out of errors', async () => {
    const { result } = await run([failure(500), failure(500), failure(500)]);
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuseError);
    const text = `${(err as Error).message} ${JSON.stringify(err)}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Write tests');
  });
});

describe('input and output budget', () => {
  it('allows a 1M-token request with its full output inside the context window', () => {
    expect(DEFAULT_INPUT_TOKEN_CEILING).toBe(1_000_000);
    expect(DEFAULT_INPUT_TOKEN_CEILING + CANDIDATE_MAX_COMPLETION_TOKENS).toBeLessThanOrEqual(
      CONTEXT_WINDOW,
    );
  });
});

describe('countInputTokens', () => {
  it('counts the complete request: every message and the output schema', async () => {
    const candidate = candidateBody('muse-spark-1.3', '<repo></repo>', 'Resume text');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 9597 })),
    );
    expect(await countInputTokens(CONFIG, candidate, fetchMock as never)).toEqual({ tokens: 9597 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://muse.test/v1/responses/input_tokens');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'muse-spark-1.3',
      input: candidate.messages,
      text: {
        format: {
          type: 'json_schema',
          name: 'candidate_assessment',
          schema: candidate.response_format.json_schema.schema,
          strict: true,
        },
      },
    });
  });

  it('reports a failure category rather than a guess when no count is available', async () => {
    const cases: [Response | Error, string][] = [
      [failure(404), 'http_4xx'],
      [failure(429), 'rate_limited'],
      [failure(503), 'http_5xx'],
      [new Response('not json'), 'invalid_body'],
      [new TypeError('failed'), 'network'],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    ];
    for (const [response, category] of cases) {
      const fetchMock = vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      });
      expect(await countInputTokens(CONFIG, body, fetchMock as never)).toMatchObject({
        failure: category,
      });
    }
  });
});

describe('countTokens', () => {
  const sleep = vi.fn(async () => {});
  const responses = (...list: (() => Response)[]) => {
    const fetchMock = vi.fn(async () => (list.shift() ?? (() => failure(500)))());
    return fetchMock;
  };
  const counted = () => new Response(JSON.stringify({ input_tokens: 42 }));

  it('retries transient failures a bounded number of times, then counts', async () => {
    const outcomes: unknown[] = [];
    const fetchMock = responses(() => failure(503), () => failure(429, { 'retry-after': '2' }), counted);
    const tokens = await countTokens(CONFIG, body, {
      fetch: fetchMock as never,
      sleep,
      onCount: (o) => outcomes.push(o),
    });
    expect(tokens).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Retry-After is honoured; otherwise a short backoff.
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1000, 2000]);
    expect(outcomes).toEqual([
      { outcome: 'counted', failure: null, attempts: 3, latencyMs: expect.any(Number) },
    ]);
  });

  it('fails visibly and retryably, never falling back to an estimate', async () => {
    const outcomes: { failure: unknown; attempts: unknown }[] = [];
    const always = vi.fn(async () => failure(500));
    await expect(
      countTokens(CONFIG, body, { fetch: always as never, sleep, onCount: (o) => outcomes.push(o) }),
    ).rejects.toMatchObject({ code: 'count_unavailable' });
    expect(always).toHaveBeenCalledTimes(COUNT_ATTEMPTS);
    // A permanent failure is not retried.
    const bad = vi.fn(async () => failure(400));
    await expect(
      countTokens(CONFIG, body, { fetch: bad as never, sleep, onCount: (o) => outcomes.push(o) }),
    ).rejects.toMatchObject({ code: 'count_unavailable' });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => [o.failure, o.attempts])).toEqual([
      ['http_5xx', 3],
      ['http_4xx', 1],
    ]);
  });
});

describe('rate limiter', () => {
  function virtualClock() {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    return { now: () => now, advance: (ms: number) => (now += ms), sleep };
  }
  const limits = { tokensPerMinute: 3_000_000, requestsPerMinute: 150 };
  const FULL = DEFAULT_INPUT_TOKEN_CEILING + CANDIDATE_MAX_COMPLETION_TOKENS;

  it('admits full requests up to 3M tokens a minute, then waits only for the oldest to expire', async () => {
    const c = virtualClock();
    const limiter = createRateLimiter(limits, c.now, c.sleep);
    await limiter.acquire(FULL);
    c.advance(10_000);
    await limiter.acquire(FULL);
    expect(c.now()).toBe(10_000);
    await limiter.acquire(FULL);
    // 3 x 1.032M exceeds 3M: the third waits exactly until the first leaves the window.
    expect(c.now()).toBe(60_000);
    expect(c.sleep).toHaveBeenCalledTimes(1);
  });

  it('replaces a charge with actual usage, freeing room early', async () => {
    const c = virtualClock();
    const limiter = createRateLimiter(limits, c.now, c.sleep);
    const charge = await limiter.acquire(2_900_000);
    charge(100_000);
    await limiter.acquire(2_900_000);
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it('caps requests per minute', async () => {
    const c = virtualClock();
    const limiter = createRateLimiter({ ...limits, requestsPerMinute: 2 }, c.now, c.sleep);
    await limiter.acquire(1);
    await limiter.acquire(1);
    await limiter.acquire(1);
    expect(c.now()).toBe(60_000);
  });

  it('serves callers in order, so a large request is never starved by small ones', async () => {
    const c = virtualClock();
    const limiter = createRateLimiter(limits, c.now, c.sleep);
    await limiter.acquire(2_500_000);
    const order: string[] = [];
    await Promise.all([
      limiter.acquire(1_000_000).then(() => order.push('large')),
      limiter.acquire(100).then(() => order.push('small')),
    ]);
    expect(order).toEqual(['large', 'small']);
  });

  it('holds every caller back after a 429 and rejects requests over the minute limit', async () => {
    const c = virtualClock();
    const limiter = createRateLimiter(limits, c.now, c.sleep);
    limiter.pause(5_000);
    await limiter.acquire(1);
    expect(c.now()).toBe(5_000);
    await expect(limiter.acquire(3_000_001)).rejects.toMatchObject({ code: 'input_too_large' });
  });
});

describe('callMuse traffic', () => {
  it('pauses the shared limiter on a 429, so the next caller waits for Retry-After', async () => {
    const { result, limiter, sleep } = await run([failure(429, { 'retry-after': '60' })]);
    await expect(result).rejects.toMatchObject({ code: 'rate_limited' });
    await limiter.acquire(1);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('reserves counted input tokens and frees the limiter charge when the budget refuses', async () => {
    let now = 0;
    const limiter = createRateLimiter(MUSE_RATE_LIMITS, () => now, async (ms) => {
      now += ms;
    });
    const reservations: number[] = [];
    const ledger: MuseLedger = {
      reserve: async (_attempt, reserved) => {
        reservations.push(reserved);
        throw new MuseError('budget_exceeded', 'cap');
      },
      settle: async () => {},
    };
    const fetchMock = vi.fn();
    const call = callMuse({
      config: CONFIG,
      body,
      schema: JobOutputSchema,
      timeoutMs: 1000,
      ledger,
      limiter,
      inputTokens: 900_000,
      fetch: fetchMock as never,
    });
    await expect(call).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(reservations).toEqual([reservationMicroUsd('muse-spark-1.3', 900_000, 8_000)]);
    expect(fetchMock).not.toHaveBeenCalled();
    await limiter.acquire(MUSE_RATE_LIMITS.tokensPerMinute);
    expect(now).toBe(0);
  });
});
