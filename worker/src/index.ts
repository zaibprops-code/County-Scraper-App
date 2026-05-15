// ============================================================
// Railway Worker — Express HTTP Server
//
// Endpoints:
//   GET  /health         liveness probe (no auth)
//   GET  /debug-db       full DB diagnostic (no auth)
//   GET  /status         running state
//   POST /match-probate  trigger matching
//   GET  /match-probate  same — allows browser testing
// ============================================================

import express, { Request, Response, NextFunction } from "express";
import * as fs from "fs";
import {
  fetchEligibleLeads,
  updateMatchedProperty,
  updateMatchStatus,
  runDbDiagnostic,
  RESOLVED_SUPABASE_URL,
} from "./supabase";
import { searchProperty, launchBrowser, closeBrowser } from "./scraper";
import { parseName, buildSearchString } from "./nameParse";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

function logStartup(): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Hillsborough Probate Worker — Startup        ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`[Startup] Node version         : ${process.version}`);
  console.log(`[Startup] PORT                 : ${PORT}`);
  console.log(
    `[Startup] WORKER_API_KEY       : ${
      WORKER_API_KEY ? "✓ set" : "⚠  NOT SET (open access)"
    }`
  );
  console.log(
    `[Startup] PLAYWRIGHT_HEADFUL   : ${
      process.env.PLAYWRIGHT_HEADFUL ?? "false"
    }`
  );

  const supaUrl = RESOLVED_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const projectRef =
    supaUrl.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "NOT FOUND";

  console.log(
    `[Startup] SUPABASE_URL (raw)    : ${
      process.env.SUPABASE_URL ?? "(not set)"
    }`
  );
  console.log(
    `[Startup] NEXT_PUBLIC_SUPA_URL  : ${
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(not set)"
    }`
  );
  console.log(`[Startup] RESOLVED URL          : ${supaUrl || "✗ MISSING"}`);
  console.log(`[Startup] PROJECT REF           : ${projectRef}`);
  console.log(
    `[Startup] SERVICE ROLE KEY      : ${
      supaKey
        ? `✓ set (prefix: ${supaKey.slice(0, 20)}...)`
        : "✗ MISSING"
    }`
  );

  if (!supaUrl) {
    console.error(
      "[Startup] ✗ SUPABASE_URL is not set — worker WILL fail on DB calls"
    );
    console.error(
      "[Startup]   Go to Railway → Variables and add SUPABASE_URL"
    );
  }
  if (!supaKey) {
    console.error(
      "[Startup] ✗ SUPABASE_SERVICE_ROLE_KEY not set — worker WILL fail"
    );
  }

  const bins = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const b of bins) {
    if (fs.existsSync(b)) {
      console.log(`[Startup] Chromium binary       : ✓ ${b}`);
    }
  }

  try {
    require.resolve("ws");
    console.log(
      "[Startup] ws package           : ✓ (Node 20 WebSocket support active)"
    );
  } catch {
    console.warn("[Startup] ws package           : ✗ NOT FOUND");
  }

  console.log("════════════════════════════════════════════════════");
}

function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!WORKER_API_KEY) {
    next();
    return;
  }
  const raw = req.headers.authorization ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token !== WORKER_API_KEY) {
    console.warn("[Auth] Rejected — invalid key");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req: Request, res: Response) => {
  const supaUrl = RESOLVED_SUPABASE_URL;
  const projectRef =
    supaUrl.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "unknown";
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "hillsborough-probate-worker",
    node: process.version,
    supabaseProject: projectRef,
    supabaseUrl: supaUrl,
    envVarsPresent: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      WORKER_API_KEY: !!WORKER_API_KEY,
    },
  });
});

app.get("/debug-db", async (_req: Request, res: Response) => {
  console.log("[DebugDB] /debug-db called — running full diagnostic...");
  try {
    const diag = await runDbDiagnostic();
    console.log("[DebugDB] Diagnostic complete");
    res.json({
      ok: true,
      diagnostic: diag,
      instructions: {
        if_count_is_0_but_dashboard_shows_rows:
          "Railway SUPABASE_URL points to a DIFFERENT Supabase project. " +
          "Copy the exact URL from Vercel env vars into Railway Variables as SUPABASE_URL.",
        if_table_not_in_list:
          "probate_leads does not exist in this project. Run SQL migrations.",
        if_rls_error:
          "RLS is blocking reads. Run 006_fix_rls_for_worker.sql in Supabase SQL Editor.",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[DebugDB] Diagnostic failed:", msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get("/status", requireApiKey, (_req: Request, res: Response) => {
  res.json({ running: isRunning, timestamp: new Date().toISOString() });
});

let isRunning = false;

async function runMatching(): Promise<{
  totalFetched: number;
  totalProcessed: number;
  matched: number;
  noMatch: number;
  errors: number;
  elapsed: string;
}> {
  const t0 = Date.now();
  console.log("[Worker] ══ START matching run ══");
  console.log(
    `[Worker] Supabase project: ${
      RESOLVED_SUPABASE_URL.match(/\/\/([^.]+)/)?.[1] ?? "unknown"
    }`
  );

  console.log("[Worker] Pre-warming Chromium...");
  await launchBrowser();
  console.log("[Worker] Chromium ready");

  const leads = await fetchEligibleLeads();
  console.log(`[Worker] Will process ${leads.length} eligible lead(s)`);

  let matched = 0,
    noMatch = 0,
    errors = 0,
    skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(
      `[Worker] ── [${i + 1}/${leads.length}] id=${lead.id} ` +
        `case=${lead.case_number} deceased="${lead.deceased_name}"`
    );

    const parsed = parseName(lead.deceased_name);
    if (!parsed || !parsed.last || parsed.last.length < 2) {
      console.log(`[Worker] SKIP id=${lead.id}: unusable name`);
      await updateMatchStatus(lead.id, "no_match");
      skipped++;
      noMatch++;
      continue;
    }

    const searchStr = buildSearchString(parsed);
    console.log(`[Worker] Search: "${searchStr}"`);

    try {
      const result = await searchProperty(searchStr, lead.id);
      if (result) {
        console.log(
          `[Worker] ✓ MATCHED id=${lead.id}: "${result.address}, ${result.city}"`
        );
        await updateMatchedProperty(
          lead.id,
          result.address,
          result.city,
          result.state,
          result.zip
        );
        matched++;
      } else {
        await updateMatchStatus(lead.id, "no_match");
        noMatch++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] ERROR id=${lead.id}: ${msg}`);
      await updateMatchStatus(lead.id, "error");
      errors++;
    }

    if (i < leads.length - 1) {
      const delay = 2000 + Math.round(Math.random() * 1000);
      console.log(`[Worker] Waiting ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    totalFetched: leads.length,
    totalProcessed: leads.length - skipped,
    matched,
    noMatch,
    errors,
    elapsed: `${elapsed}s`,
  };
  console.log("[Worker] ══ DONE ══", summary);
  return summary;
}

app.all(
  "/match-probate",
  requireApiKey,
  async (_req: Request, res: Response) => {
    if (isRunning) {
      res.status(409).json({ error: "Matching already in progress" });
      return;
    }
    isRunning = true;
    console.log("[Worker] /match-probate triggered");
    try {
      const result = await runMatching();
      res.json({ success: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Worker] Fatal:", msg);
      res.status(500).json({ success: false, error: msg });
    } finally {
      isRunning = false;
      await closeBrowser();
    }
  }
);

logStartup();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Worker] Listening on 0.0.0.0:${PORT}`);
  console.log("[Worker] Endpoints:");
  console.log("[Worker]   GET  /health");
  console.log(
    "[Worker]   GET  /debug-db    ← HIT THIS to diagnose 0-rows issue"
  );
  console.log("[Worker]   GET  /status");
  console.log("[Worker]   POST /match-probate");
});
