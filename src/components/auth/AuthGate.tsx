"use client";

import { LogIn } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

type AuthGateProps = {
  title?: string;
  message?: string;
};

export function AuthGate({
  title = "Googleログインが必要です",
  message = "勉強セッションの作成、保存、一覧表示はログイン後に使えます。",
}: AuthGateProps) {
  const { signInWithGoogle } = useAuth();

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6">
      <h2 className="text-xl font-semibold text-zinc-950">{title}</h2>
      <p className="mt-2 text-sm text-zinc-600">{message}</p>
      <button
        type="button"
        onClick={() => void signInWithGoogle()}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800"
      >
        <LogIn size={18} />
        Googleでログイン
      </button>
    </section>
  );
}
