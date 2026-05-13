// ============================================================
// /api/match-properties — Delegates to Railway Playwright worker
//
// The Railway worker runs a real Chromium browser to scrape HCPA.
// This Vercel route just forwards the request and streams back
// the result.
//
// Required Vercel env vars:
//   RAILWAY_WORKER_URL  = https://your-worker.railway.app
//   WORKER_API_KEY      = (same key set on Railway)
// ============================================================

import { NextResponse } from "next/server";
import type { PropertyMatchResult } from "@/types/leads";

export const dynamic = "force-dynamic";
// Short timeout — just enough to trigger the worker and get a response.
// The worker itself handles the long-running scraping.
export const maxDuration = 60;

export async function GET(): Promise<NextResponse> {
  console.log("[MatchRoute] ▶ Forwarding to Railway worker...");

  const workerUrl = process.env.RAILWAY_WORKER_URL?.replace(/\/$/, "");
  const apiKey = process.env.WORKER_API_KEY;

  if (!workerUrl) {
    console.error("[MatchRoute] RAILWAY_WORKER_URL env var not set");
    return NextResponse.json(
      {
        success: false,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 1,
        error:
          "RAILWAY_WORKER_URL is not configured. Add it to your Vercel environment variables.",
      } satisfies PropertyMatchResult,
      { status: 500 }
    );
  }

  if (!apiKey) {
    console.error("[MatchRoute] WORKER_API_KEY env var not set");
    return NextResponse.json(
      {
        success: false,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 1,
        error:
          "WORKER_API_KEY is not configured. Add it to your Vercel environment variables.",
      } satisfies PropertyMatchResult,
      { status: 500 }
    );
  }

  const endpoint = `${workerUrl}/match-probate`;
  console.log(`[MatchRoute] Calling: POST ${endpoint}`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // 55s fetch timeout — slightly under Vercel's 60s limit
      signal: AbortSignal.timeout(55000),
    });

    console.log(`[MatchRoute] Worker HTTP status: ${resp.status}`);

    const json = await resp.json();
    console.log(`[MatchRoute] Worker response:`, JSON.stringify(json));

    if (resp.status === 409) {
      // Worker already running — return as success with message
      return NextResponse.json({
        success: true,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 0,
        message: json.message ?? "Matching already in progress on the worker.",
      } satisfies PropertyMatchResult);
    }

    if (!resp.ok) {
      return NextResponse.json(
        {
          success: false,
          totalProcessed: 0,
          matched: 0,
          noMatch: 0,
          errors: 1,
          error: json.error ?? `Worker returned HTTP ${resp.status}`,
        } satisfies PropertyMatchResult,
        { status: 500 }
      );
    }

    // Map worker response to PropertyMatchResult shape
    const result: PropertyMatchResult = {
      success: json.success ?? true,
      totalProcessed: json.totalProcessed ?? 0,
      matched: json.matched ?? 0,
      noMatch: json.noMatch ?? 0,
      errors: json.errors ?? 0,
      message:
        json.elapsed
          ? `Done in ${json.elapsed} — Fetched: ${json.totalFetched} · Processed: ${json.totalProcessed}`
          : json.message,
      error: json.error,
    };

    console.log("[MatchRoute] ✓ Done:", result);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[MatchRoute] Fetch to worker failed:", msg);

    // Specific message for timeout
    const isTimeout = msg.includes("timeout") || msg.includes("abort") || msg.includes("AbortError");

    return NextResponse.json(
      {
        success: false,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 1,
        error: isTimeout
          ? "Worker timed out. The worker is still running in the background — check Railway logs and refresh the dashboard in a few minutes."
          : `Could not reach Railway worker: ${msg}. Check that RAILWAY_WORKER_URL is correct and the worker is deployed.`,
      } satisfies PropertyMatchResult,
      { status: 500 }
    );
  }
}
