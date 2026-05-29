import { NextResponse } from "next/server";
import { getDashboardStats } from "@/lib/sessions/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await getDashboardStats();
  return NextResponse.json({ stats });
}
