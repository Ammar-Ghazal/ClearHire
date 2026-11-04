// GitHub sign-in routes (R-2.4, R-3.2, R-3.3).
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { githubConnections, userEmails, users } from "../db/schema.js";
import { env } from "../env.js";
import { encrypt, randomToken } from "../lib/crypto.js";
import {
  authorizeUrl,
  exchangeCode,
  fetchProfile,
  GitHubAuthError,
  startDeviceSignIn,
  pollDeviceSignIn,
  type UserTokens,
} from "../lib/github.js";
import {
  cookieOptions,
  createSession,
  destroySession,
} from "../lib/sessions.js";

const STATE_COOKIE = "ch_oauth_state";

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  installation_id: z.string().optional(),
  setup_action: z.string().optional(),
});

/** Sends the browser back to the operator page with a short error code it can display. */
function backToWeb(reply: FastifyReply, params: Record<string, string> = {}) {
  const url = new URL("/operator", env.WEB_ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return reply.redirect(url.toString());
}

async function signIn(reply: FastifyReply, tokens: UserTokens) {
  const profile = await fetchProfile(tokens.accessToken);

  const userId = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        githubUserId: profile.id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      })
      .onConflictDoUpdate({
        target: users.githubUserId,
        set: {
          login: profile.login,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: users.id });
    if (!user) throw new Error("User upsert returned no row");

    await tx.delete(userEmails).where(eq(userEmails.userId, user.id));
    if (profile.emails.length > 0) {
      await tx
        .insert(userEmails)
        .values(profile.emails.map((e) => ({ userId: user.id, ...e })));
    }

    const connection = {
      installationId: profile.installationId,
      accessTokenEnc: encrypt(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: tokens.refreshToken
        ? encrypt(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY)
        : null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      status: "active" as const,
      updatedAt: new Date(),
    };
    await tx
      .insert(githubConnections)
      .values({ userId: user.id, ...connection })
      .onConflictDoUpdate({
        target: githubConnections.userId,
        set: connection,
      });

    return user.id;
  });

  await createSession(reply, userId);
}

export async function authRoutes(app: FastifyInstance) {
  const cookie = "ch_github_device";
  const attempts = new Map<
    string,
    {
      deviceCode: string;
      expiresAt: number;
      interval: number;
      nextPoll: number;
      polling: boolean;
    }
  >();

  app.post(
    "/auth/github/device",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!env.GITHUB_CLIENT_ID)
        return reply
          .code(503)
          .send({ error: { code: "github_not_configured" } });
      const now = Date.now();
      for (const [id, attempt] of attempts)
        if (attempt.expiresAt <= now) attempts.delete(id);
      const previous = request.unsignCookie(request.cookies[cookie] ?? "");
      if (previous.valid && previous.value) attempts.delete(previous.value);
      try {
        const code = await startDeviceSignIn();
        const id = randomToken();
        const interval = code.interval * 1000;
        attempts.set(id, {
          deviceCode: code.device_code,
          expiresAt: Date.now() + code.expires_in * 1000,
          interval,
          nextPoll: Date.now() + interval,
          polling: false,
        });
        reply.setCookie(cookie, id, {
          ...cookieOptions,
          maxAge: code.expires_in,
        });
        return { code: code.user_code, intervalMs: interval };
      } catch {
        return reply
          .code(502)
          .send({
            error: {
              code: "github_device_unavailable",
              message:
                "GitHub could not start sign-in. Check that device flow is enabled.",
            },
          });
      }
    },
  );

  app.post("/auth/github/device/poll", async (request, reply) => {
    const signed = request.unsignCookie(request.cookies[cookie] ?? "");
    const id = signed.valid ? signed.value : null;
    const attempt = id ? attempts.get(id) : undefined;
    if (!id || !attempt || Date.now() >= attempt.expiresAt) {
      if (id) attempts.delete(id);
      return { status: "expired" };
    }
    if (attempt.polling || Date.now() < attempt.nextPoll) {
      return { status: "pending", intervalMs: attempt.interval };
    }
    attempt.polling = true;
    try {
      const result = await pollDeviceSignIn(attempt.deviceCode);
      if (attempts.get(id) !== attempt) return { status: "expired" };
      if (result === "authorization_pending" || result === "slow_down") {
        if (result === "slow_down") attempt.interval += 5000;
        return { status: "pending", intervalMs: attempt.interval };
      }
      attempts.delete(id);
      reply.clearCookie(cookie, { path: "/" });
      if (typeof result === "string") return { status: "denied" };
      await signIn(reply, result);
      return { status: "signed_in" };
    } catch {
      attempts.delete(id);
      return { status: "failed" };
    } finally {
      attempt.polling = false;
      attempt.nextPoll = Date.now() + attempt.interval;
    }
  });

  // Starts sign-in: a random state goes into a signed cookie and to GitHub; the callback compares them.
  app.get("/auth/github/login", async (_request, reply) => {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return reply.code(503).send({
        error: {
          code: "github_not_configured",
          message:
            "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart the API.",
        },
      });
    }
    const state = randomToken(24);
    reply.setCookie(STATE_COOKIE, state, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(authorizeUrl(state));
  });

  app.get("/auth/github/callback", async (request, reply) => {
    const query = CallbackQuery.safeParse(request.query);
    if (!query.success) return backToWeb(reply, { auth_error: "bad_callback" });
    const { code, state, error, setup_action } = query.data;

    if (error) return backToWeb(reply, { auth_error: error });

    // Returning from installing the App: GitHub sends no state here, so never trust this code.
    // Start a normal sign-in instead; GitHub approves it instantly and we pick up the installation.
    if (!state && setup_action)
      return reply.redirect(`${env.API_PUBLIC_URL}/auth/github/login`);

    const rawState = request.cookies[STATE_COOKIE];
    const expected = rawState ? request.unsignCookie(rawState) : null;
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (!code || !state || !expected?.valid || expected.value !== state) {
      return backToWeb(reply, { auth_error: "state_mismatch" });
    }

    try {
      const tokens = await exchangeCode(code);
      await signIn(reply, tokens);
      return backToWeb(reply);
    } catch (err) {
      request.log.error({ err }, "GitHub sign-in failed");
      const code = err instanceof GitHubAuthError ? err.code : "signin_failed";
      return backToWeb(reply, { auth_error: code });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return reply.code(204).send();
  });
}
