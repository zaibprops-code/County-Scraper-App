// ============================================================
// /api/clear — Delete all leads and reset DB to empty state
// POST /api/clear
// ============================================================

import { NextResponse } from "next/server";
import { clearAllLeads } from "@/lib/storage";
import type { ClearResult } from "@/types/leads";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  console.log("[Clear] ▶ Clearing all records...");
  try {
    await clearAllLeads();
    const result: ClearResult = {
      success: true,
      message: "All records cleared successfully.",
    };
    console.log("[Clear] ✓ Done");
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Clear] ✗ Error:", message);
    return NextResponse.json(
      { success: false, message: "Failed to clear records.", error: message } satisfies ClearResult,
      { status: 500 }
    );
  }
}
