// Demo identity: which sample candidate or employer this browser is acting as. A separate signed
// cookie from the `ch_sid` session; it is never authentication and never grants paid analysis.
import type { DemoSide } from '@clearhire/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { demoCandidates, demoEmployers } from '../db/schema.js';
import { cookieOptions } from './sessions.js';

export const DEMO_IDENTITY_COOKIE = 'ch_demo';

export interface DemoIdentityRef {
  kind: DemoSide;
  key: string;
}

/** Only non-organization candidates and existing employers can be chosen. */
export async function identityExists({ kind, key }: DemoIdentityRef): Promise<boolean> {
  const rows =
    kind === 'candidate'
      ? await db
          .select({ key: demoCandidates.key })
          .from(demoCandidates)
          .where(and(eq(demoCandidates.key, key), eq(demoCandidates.organization, false)))
      : await db
          .select({ key: demoEmployers.id })
          .from(demoEmployers)
          .where(eq(demoEmployers.id, key));
  return rows.length > 0;
}

export function setDemoIdentity(reply: FastifyReply, identity: DemoIdentityRef): void {
  reply.setCookie(DEMO_IDENTITY_COOKIE, `${identity.kind}:${identity.key}`, cookieOptions);
}

export function clearDemoIdentity(reply: FastifyReply): void {
  reply.clearCookie(DEMO_IDENTITY_COOKIE, { path: '/' });
}

/** The current identity, or null when unset, tampered with or no longer imported. */
export async function currentDemoIdentity(request: FastifyRequest): Promise<DemoIdentityRef | null> {
  const raw = request.cookies[DEMO_IDENTITY_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  const at = unsigned.value.indexOf(':');
  const kind = unsigned.value.slice(0, at);
  if (kind !== 'candidate' && kind !== 'employer') return null;
  const identity = { kind, key: unsigned.value.slice(at + 1) } as const;
  return (await identityExists(identity)) ? identity : null;
}
