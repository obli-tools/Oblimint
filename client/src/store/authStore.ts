import { create } from 'zustand';
import type { User } from '@oblimint/shared';
import type { UserPermissions } from '@/types';
import { authApi, type LoginResult } from '../api/auth.api';
import { connectSocket, disconnectSocket } from '../socket/socketClient';
import { setLanguage } from '../i18n';
import { useTenantStore } from './tenantStore';
import { applyTheme, isKnownTheme } from '../utils/theme';

export type { UserPermissions };

function syncPreferencesToStore(user: User) {
  const prefs = user.preferences;
  if (prefs) {
    // Theme is owned by Obligate (SSO) — when the user picks a theme there,
    // it lands in user.preferences.preferredTheme on the next /auth/me. We
    // must apply it to the DOM here, otherwise the boot-time initTheme()
    // (which only reads localStorage) keeps a stale theme. Unknown ids keep
    // the current theme instead of forcing the Operator fallback.
    const t = (prefs as { preferredTheme?: string }).preferredTheme;
    if (isKnownTheme(t)) {
      applyTheme(t);
    }
  }
  if (user.preferredLanguage) {
    setLanguage(user.preferredLanguage);
  }
}

interface AuthState {
  user: User | null;
  permissions: UserPermissions | null;
  requires2faSetup: boolean;
  isLoading: boolean;
  isInitialized: boolean;

  login: (username: string, password: string) => Promise<LoginResult>;
  /** Install a user obtained by another path (TOTP verify step of the login). */
  setUser: (user: User) => void;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;

  isAdmin: () => boolean;
  hasCapability: (cap: string) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  permissions: null,
  requires2faSetup: false,
  isLoading: false,
  isInitialized: false,

  login: async (username: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await authApi.login({ username, password });

      // 2FA required — don't set user yet, return the challenge to caller
      if (result.requires2fa) {
        set({ isLoading: false });
        return result;
      }

      set({ isLoading: false });
      get().setUser(result.user);
      return result;
    } catch (err) {
      set({ isLoading: false });
      const axiosErr = err as { response?: { data?: { error?: string; code?: string }; status?: number }; message?: string };
      const serverMessage = axiosErr?.response?.data?.error;
      const status = axiosErr?.response?.status;
      // SSO (og_) account without a local TOTP: it signs in through Obligate.
      if (status === 403 && axiosErr?.response?.data?.code === 'ssoLoginRequired') {
        throw Object.assign(new Error(serverMessage ?? 'This account signs in through Obligate (SSO).'), { code: 'ssoLoginRequired' });
      }
      // Client space (client_panel_hostname): this user signs in at another address.
      if (status === 403 && axiosErr?.response?.data?.code === 'wrongPanelHost') {
        const data = axiosErr.response.data as { url?: string | null; expected?: 'admin' | 'client' };
        throw Object.assign(new Error(serverMessage ?? 'Sign in at the other address.'), { code: 'wrongPanelHost', url: data.url ?? null, expected: data.expected ?? null });
      }
      // The account belongs to no tenant: no session (the login page says why).
      if (status === 403 && axiosErr?.response?.data?.code === 'noTenantAccess') {
        throw Object.assign(new Error(serverMessage ?? 'This account has no access to any tenant.'), { code: 'noTenantAccess' });
      }
      if (status === 429) {
        throw Object.assign(new Error(serverMessage ?? 'Too many login attempts, please try again later'), { code: 'tooManyAttempts' });
      } else if (status === 401) {
        throw Object.assign(new Error(serverMessage ?? 'Invalid username or password'), { code: 'invalidCredentials' });
      } else if (serverMessage) {
        throw new Error(serverMessage);
      } else {
        throw Object.assign(new Error(axiosErr?.message ?? 'Unable to connect to the server'), { code: 'network' });
      }
    }
  },

  setUser: (user: User) => {
    set({ user });
    syncPreferencesToStore(user);
    connectSocket(user.id);
    useTenantStore.getState().fetchTenants();
    // Fetch permissions / current tenant in the background; failure is non-fatal.
    authApi.me()
      .then(({ permissions, user: fullUser, requires2faSetup, currentTenantId }) => {
        set({ user: fullUser, permissions: permissions ?? null, requires2faSetup: requires2faSetup ?? false });
        syncPreferencesToStore(fullUser);
        if (currentTenantId != null) {
          useTenantStore.setState({ currentTenantId });
        }
      })
      .catch(() => { /* non-critical — loads on next checkSession */ });
  },

  logout: async () => {
    // Fetch Obligate logout URL BEFORE destroying local state
    let obligateLogoutUrl: string | null = null;
    try {
      const res = await fetch('/api/auth/sso-logout-url', { credentials: 'include' });
      const data = await res.json() as { success: boolean; data: string | null };
      if (data.success && data.data) obligateLogoutUrl = data.data;
    } catch { /* ignore */ }

    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      set({ user: null, permissions: null, requires2faSetup: false });
    }

    if (obligateLogoutUrl) {
      window.location.href = obligateLogoutUrl;
    }
  },

  checkSession: async () => {
    try {
      const { user, permissions, requires2faSetup, currentTenantId } = await authApi.me();
      // Tenant first: master-only routes (ProtectedRoute requireMaster) read
      // it as soon as isInitialized flips.
      if (currentTenantId != null) {
        useTenantStore.setState({ currentTenantId });
      }
      set({ user, permissions: permissions ?? null, requires2faSetup: requires2faSetup ?? false, isInitialized: true });
      syncPreferencesToStore(user);
      connectSocket(user.id, currentTenantId ?? undefined);
      useTenantStore.getState().fetchTenants();
      if (currentTenantId != null) {
        useTenantStore.setState({ currentTenantId });
      }
    } catch {
      set({ user: null, permissions: null, requires2faSetup: false, isInitialized: true });
    }
  },

  isAdmin: () => get().user?.role === 'admin',

  hasCapability: (cap: string) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return permissions?.tenantCapabilities?.includes(cap) ?? false;
  },
}));
