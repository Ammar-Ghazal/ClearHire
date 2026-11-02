import { describe, expect, it, vi } from 'vitest';
import {
  assertDataUse,
  callMuse,
  candidateBody,
  costMicroUsd,
  jobBody,
  JobOutputSchema,
  MuseError,
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

async function run(responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const memory = memoryLedger();
  const result = callMuse({
    config: CONFIG,
    body,
    schema: JobOutputSchema,
    timeoutMs: 1000,
    ledger: memory.ledger,
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
  });
  return { result, fetchMock, sleep, ...memory };
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

  it('stops after the single retry', async () => {
    const { result, fetchMock } = await run([failure(429), failure(429)]);
    await expect(result).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast when Retry-After exceeds the limit and keeps a 503 charge as ambiguous', async () => {
    const { result, fetchMock, settlements } = await run([failure(503, { 'retry-after': '60' })]);
    await expect(result).rejects.toMatchObject({ code: 'unavailable', retryAfterMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settlements[0]).toMatchObject({ settlement: 'ambiguous', costSource: 'reservation' });
  });

  it.each([
    ['timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout', 'ambiguous'],
    ['network failure', new TypeError('fetch failed'), 'network', 'ambiguous'],
    ['HTTP 408', failure(408), 'timeout', 'ambiguous'],
    ['HTTP 504', failure(504), 'unavailable', 'ambiguous'],
    ['HTTP 400', failure(400), 'bad_request', 'released'],
    ['HTTP 401', failure(401), 'auth', 'released'],
  ])('never resends after a %s', async (_label, response, code, settlement) => {
    const { result, fetchMock, settlements } = await run([response, completion(OUTPUT)]);
    await expect(result).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settlements).toEqual([expect.objectContaining({ settlement })]);
  });

  it.each([
    ['truncated output', completion(OUTPUT, { finish: 'length' }), 'truncated'],
    ['a refusal', completion(null, { refusal: 'No' }), 'refused'],
    ['schema-invalid output', completion({ in_scope: 'yes' }), 'invalid_output'],
  ])(
    'fails without retrying on %s, still charging actual usage',
    async (_label, response, code) => {
      const { result, fetchMock, settlements } = await run([response, completion(OUTPUT)]);
      await expect(result).rejects.toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(settlements).toEqual([
        expect.objectContaining({ settlement: 'settled', costSource: 'usage' }),
      ]);
    },
  );

  it('charges the full reservation when a successful response omits usage', async () => {
    const { result, settlements, reservations } = await run([completion(OUTPUT, { usage: null })]);
    await expect(result).resolves.toBeDefined();
    expect(settlements[0]).toMatchObject({
      costSource: 'reservation',
      costMicroUsd: reservations[0],
    });
  });

  it('keeps the key and request text out of errors', async () => {
    const { result } = await run([failure(500), failure(500)]);
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuseError);
    const text = `${(err as Error).message} ${JSON.stringify(err)}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Write tests');
  });
});
