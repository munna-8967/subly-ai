import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, SESSION_EXPIRED_EVENT } from './api';
import type { Account, Balance, SubscriptionInfo, User } from '../types';

interface AuthValue {
  /** undefined while the first check runs, null when signed out */
  user: User | null | undefined;
  credits: Balance | null;
  subscription: SubscriptionInfo | null;
  unread: number;
  setAccount: (account: Account) => void;
  /** reload balance, plan and unread count from the server (call after anything that spends or buys credits) */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  user: undefined, credits: null, subscription: null, unread: 0, setAccount: () => undefined, refresh: async () => undefined, signOut: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccountState] = useState<Account | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setAccountState('user' in me && me.user === null ? null : (me as Account));
    } catch {
      /* server unreachable: keep what we have */
      setAccountState((current) => (current === undefined ? null : current));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const expired = () => setAccountState(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAccountState(null);
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user: account === undefined ? undefined : account === null ? null : account.user,
      credits: account?.credits ?? null,
      subscription: account?.subscription ?? null,
      unread: account?.unreadNotifications ?? 0,
      setAccount: (a) => setAccountState(a),
      refresh,
      signOut,
    }),
    [account, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
