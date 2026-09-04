'use client';
import { create } from 'zustand';
import { api, setAccessToken, type User } from '@/lib/api';

interface AuthState {
  user: User | null;
  status: 'loading' | 'authed' | 'anon';
  signIn: (identifier: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => Promise<void>;
  restore: () => Promise<void>;
}

export interface SignUpInput {
  username: string; displayName: string; email: string;
  password: string; dateOfBirth: string;
}

interface AuthResponse { user: User; accessToken: string }

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',

  /**
   * Restores a session on page load using the httpOnly refresh cookie.
   *
   * This is why the access token can live in memory: a reload loses it, but the
   * cookie the browser still holds mints a new one before the first paint the
   * user notices.
   */
  restore: async () => {
    try {
      const r = await api<AuthResponse>('/auth/refresh', { method: 'POST', retry: false });
      // Belt and braces after a real bug: a 2xx with no token or no user is not
      // a session, whatever the status line says.
      if (!r?.accessToken || !r?.user) throw new Error('no session');
      setAccessToken(r.accessToken);
      set({ user: r.user, status: 'authed' });
    } catch {
      setAccessToken(null);
      set({ user: null, status: 'anon' });
    }
  },

  signIn: async (identifier, password) => {
    const r = await api<AuthResponse>('/auth/login', { method: 'POST', body: { identifier, password } });
    setAccessToken(r.accessToken);
    set({ user: r.user, status: 'authed' });
  },

  signUp: async (input) => {
    const r = await api<AuthResponse>('/auth/register', { method: 'POST', body: input });
    setAccessToken(r.accessToken);
    set({ user: r.user, status: 'authed' });
  },

  signOut: async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    set({ user: null, status: 'anon' });
  },
}));
