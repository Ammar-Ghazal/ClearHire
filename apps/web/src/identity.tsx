// The chosen demo identity (a sample candidate or employer) and its badge counts.
import type { DemoIdentity } from '@clearhire/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getDemoIdentity } from './api';

interface IdentityState {
  /** undefined while loading, null when none is chosen. */
  identity: DemoIdentity | null | undefined;
  setIdentity: (identity: DemoIdentity | null) => void;
  /** Reloads badge counts after an action. */
  refresh: () => void;
}

const IdentityContext = createContext<IdentityState | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<DemoIdentity | null | undefined>(undefined);
  const refresh = useCallback(() => {
    getDemoIdentity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <IdentityContext.Provider value={{ identity, setIdentity, refresh }}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const state = useContext(IdentityContext);
  if (!state) throw new Error('useIdentity needs IdentityProvider');
  return state;
}

/** For pages inside the shell, which only renders once an identity is chosen. */
export function useChosenIdentity() {
  const { identity, refresh } = useIdentity();
  if (!identity) throw new Error('No demo identity');
  return { ...identity, refresh };
}
