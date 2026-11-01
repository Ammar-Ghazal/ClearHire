// Server-side sessions (R-2.8): the cookie holds only a signed random id; the row lives in Postgres.
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { isProduction } from '../env.js';
import { randomToken } from './crypto.js';

export const SESSION_COOKIE = 'ch_sid';
const SESSION_DAYS = 30;

export const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax' as const,
  path: '/',
  signed: true,
};

export async function createSession(reply: FastifyReply, userId: string): Promise<void> {
  const id = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id, userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, id, { ...cookieOptions, expires: expiresAt });
}

function sessionIdFrom(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

/** Returns the signed-in user's id, or null. */
export async function currentUserId(request: FastifyRequest): Promise<string | null> {
  const id = sessionIdFrom(request);
  if (!id) return null;
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row?.userId ?? null;
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = sessionIdFrom(request);
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
