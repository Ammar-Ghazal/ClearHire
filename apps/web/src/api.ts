// Thin client for the API. In development the base is /api (proxied by Vite);
// in production set VITE_API_URL to the API's public URL.
import { HealthSchema, MeSchema, type Health, type Me } from '@hireproof/shared';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

export const loginUrl = `${API_BASE}/auth/github/login`;

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
