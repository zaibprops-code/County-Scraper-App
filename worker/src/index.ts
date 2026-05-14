// ============================================================
// Railway Worker — Express HTTP Server
//
// Endpoints:
//   GET  /health         liveness probe (no auth required)
//   GET  /status         current running state
//   POST /match-probate  trigger property matching
//   GET  /match-probate  same — allows quick browser test
//
// Auth: Authorization: Bearer <WORKER_API_KEY>
// ============================================================

import express, { Request, Response, NextFunction } from "express";
import * as fs from "fs";
import {
  fetchEligibleLeads,
  updateMatchedProperty,
  updateMatchStatus,
} from "./supabase";
import { searchProperty, launchBrowser, closeBrowser } from "./scraper";
import { parseName, buildSearchString } from "./nameParse";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

// ── Startup validation ───────────────────────────────────────

function validateEnv(): void {
  console.log("[Worker] ══════════════════════════════════════");
  console.log("[Worker] Hillsborough Probate Worker starting");
  console.log("[Worker] ══════════════════════════════════════");
  console.log(`[Worker] Node version : ${process.version}`);
  console.log(`[Worker] PORT         : ${PORT}`);

  const supaUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  console.log(
    `[Worker] SUPABASE_URL : ${supaUrl ? `✓ ${supaUrl}` : "✗ MISSING — set in Railway Variables"}`
  );
  console.log(
    `[Worker] SERVICE_KEY  : ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "✓ set" : "✗ MISSING — set in Railway Variables"}`
  );
  console.log(
    `[Worker] API_KEY      : ${WORKER_API_KEY ? "✓ set" : "⚠  not set — all requests accepted"}`
  );
  console.log(
    `[Worker] CHROMIUM     : ${process.env.CHROMIUM_PATH ?? "auto-detect"}`
  );
  console.log(
    `[Worker] HEADFUL      : ${process.env.PLAYWRIGHT_HEADFUL ?? "false"}`
  );

  // List Chromium binaries present in container
  const bins = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const b of bins) {
    if (fs.existsSync(b)) console.log(`[Worker] Chromium binary  : ✓ ${b}`);
  }

  // Confirm ws package resolves
  try {
    require.resolve("ws");
    console.log("[Worker] ws package       : ✓ resolved (Node 20 WebSocket fix active)");
  } catch {
    console.warn("[Worker] ws package       : ✗ NOT FOUND — run npm install");
  }

  console.log("[Worker] ══════════════════════════════════════");
}

// ── Auth middleware ──────────────────────────────────────────

function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!WORKER_API_KEY) {
    // No key configured — open access (acceptable for private Railway service)
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (token !== WORKER_API_KEY) {
    console.warn("[Auth] Request rejected — invalid API key");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health ──────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "hillsborough-probate-worker",
    node: process.version,
    env: {
      supabaseConfigured: !!(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
      ),
      serviceKeyConfigured: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      apiKeySet: !!WORKER_API_KEY,
    },
  });
});

// ── Status ──────────────────────────────────────────────────

app.get("/status", requireApiKey, (_req: Request, res: Response) => {
  res.json({ running: isRunning, timestamp: new Date().toISOString() });
});

// ── Matching run ─────────────────────────────────────────────

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

  // Pre-warm browser so first lead doesn't pay the launch cost
  console.log("[Worker] Pre-warming Chromium...");
  await launchBrowser();
  console.log("[Worker] Chromium ready");

  const leads = await fetchEligibleLeads();
  console.log(`[Worker] Will process ${leads.length} eligible lead(s)`);

  let matched = 0;
  let noMatch = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(
      `[Worker] ── [${i + 1}/${leads.length}] id=${lead.id} ` +
        `case=${lead.case_number} deceased="${lead.deceased_name}"`
    );

    // Parse name
    const parsed = parseName(lead.deceased_name);
    if (!parsed || !parsed.last || parsed.last.length < 2) {
      console.log(`[Worker] SKIP id=${lead.id}: cannot parse usable last name`);
      await updateMatchStatus(lead.id, "no_match");
      skipped++;
      noMatch++;
      continue;
    }

    const searchStr = buildSearchString(parsed);
    console.log(
      `[Worker] Search string: "${searchStr}"  ` +
        `(last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}")`
    );

    try {
      const result = await searchProperty(searchStr, lead.id);

      if (result) {
        console.log(
          `[Worker] ✓ MATCHED id=${lead.id}: ` +
            `"${result.address}, ${result.city}, ${result.state} ${result.zip ?? ""}"`
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
        console.log(`[Worker] ✗ no_match id=${lead.id}`);
        await updateMatchStatus(lead.id, "no_match");
        noMatch++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] ERROR id=${lead.id}: ${msg}`);
      await updateMatchStatus(lead.id, "error");
      errors++;
    }

    // Polite delay between HCPA requests
    if (i < leads.length - 1) {
      const delayMs = 2000 + Math.round(Math.random() * 1000);
      console.log(`[Worker] Waiting ${delayMs}ms before next lead...`);
      await new Promise((r) => setTimeout(r, delayMs));
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

// ── /match-probate endpoint ──────────────────────────────────

app.all(
  "/match-probate",
  requireApiKey,
  async (_req: Request, res: Response) => {
    if (isRunning) {
      console.log("[Worker] Already running — rejecting concurrent request");
      res.status(409).json({
        error: "Matching already in progress",
        message: "Wait for the current run to finish, then try again.",
      });
      return;
    }

    isRunning = true;
    console.log("[Worker] /match-probate triggered");

    try {
      const result = await runMatching();
      res.json({ success: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Worker] Fatal matching error:", msg);
      res.status(500).json({ success: false, error: msg });
    } finally {
      isRunning = false;
      // Free memory after each run
      await closeBrowser();
      console.log("[Worker] Browser closed — ready for next request");
    }
  }
);

// ── Start server ─────────────────────────────────────────────

validateEnv();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Worker] Listening on 0.0.0.0:${PORT}`);
  console.log(
    "[Worker] Available: GET /health  GET /status  POST /match-probate"
  );
});
