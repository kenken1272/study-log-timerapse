"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "firebase/auth";
import {
  getCurrentFirebaseIdToken,
  observeFirebaseAuth,
  signInWithGoogle as firebaseSignInWithGoogle,
  signOutFromGoogle,
} from "@/lib/firebase/auth";

export type UserProfile = {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  weeklyGoalHours: number;
  createdAt: string;
  updatedAt: string;
};

type AuthContextValue = {
  user: User | null;
  profile: UserProfile | null;
  isLoading: boolean;
  profileError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  refreshProfile: () => Promise<UserProfile | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function readProfile(token: string): Promise<UserProfile> {
  const response = await fetch("/api/profile", {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "プロフィールを読み込めませんでした。");
  }

  const body = (await response.json()) as { profile: UserProfile };
  return body.profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    return observeFirebaseAuth((nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
      if (!nextUser) {
        setProfile(null);
        setProfileError(null);
      }
    });
  }, []);

  const getIdToken = useCallback(async (forceRefresh = false) => {
    const token = await getCurrentFirebaseIdToken(forceRefresh);
    if (!token) {
      throw new Error("ログインが必要です。");
    }

    return token;
  }, []);

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const token = await getIdToken();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);

      return fetch(input, {
        ...init,
        headers,
      });
    },
    [getIdToken],
  );

  const refreshProfile = useCallback(async () => {
    if (!user) {
      setProfile(null);
      return null;
    }

    const token = await getIdToken(true);
    const nextProfile = await readProfile(token);
    setProfile(nextProfile);
    setProfileError(null);
    return nextProfile;
  }, [getIdToken, user]);

  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      if (!user) {
        return;
      }

      try {
        const token = await getIdToken();
        const nextProfile = await readProfile(token);
        if (!cancelled) {
          setProfile(nextProfile);
          setProfileError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setProfileError(
            error instanceof Error ? error.message : "プロフィールを読み込めませんでした。",
          );
        }
      }
    }

    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [getIdToken, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      isLoading,
      profileError,
      signInWithGoogle: async () => {
        await firebaseSignInWithGoogle();
      },
      signOut: signOutFromGoogle,
      getIdToken,
      authFetch,
      refreshProfile,
    }),
    [authFetch, getIdToken, isLoading, profile, profileError, refreshProfile, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }

  return context;
}
