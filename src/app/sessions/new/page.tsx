import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CameraRecorder } from "@/components/CameraRecorder";

export default function NewSessionPage() {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
        >
          <ArrowLeft size={16} />
          ダッシュボードへ
        </Link>
        <header className="my-8">
          <h1 className="text-3xl font-semibold tracking-normal">勉強セッション開始</h1>
        </header>
        <CameraRecorder />
      </div>
    </main>
  );
}
