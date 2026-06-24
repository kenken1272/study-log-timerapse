"use client";

import { LogIn, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

export function AuthControls() {
  const { isLoading, profile, signInWithGoogle, signOut, user } = useAuth();

  if (isLoading) {
    return (
      <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500">
        認証確認中...
      </div>
    );
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => void signInWithGoogle()}
        className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800"
      >
        <LogIn size={18} />
        Googleでログイン
      </button>
    );
  }

  const displayName = profile?.name || user.displayName || "ログインユーザー";
  const email = profile?.email || user.email || "";
  const photoURL = profile?.photoURL || user.photoURL;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2">
      {photoURL ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoURL}
          alt=""
          className="h-9 w-9 rounded-full border border-zinc-200 object-cover"
        />
      ) : null}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-950">{displayName}</p>
        {email ? <p className="truncate text-xs text-zinc-500">{email}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-800 hover:bg-zinc-50"
      >
        <LogOut size={16} />
        ログアウト
      </button>
    </div>
  );
}
