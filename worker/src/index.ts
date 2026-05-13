// ============================================================
// Railway Worker — Express HTTP Server
//
// Endpoints:
//   GET  /health          — liveness check
//   POST /match-probate   — trigger probate property matching
//   GET  /match-probate   — same (allows easy browser testing)
//
// Authentication: Authorization: Bearer <WORKER_API_KEY>
// ============================================================

import express, { Request, Response, NextFunction } from "express";
import {
  fetchEligibleLeads,
  updateMatchedProperty,
  updateMatchStatus,
} from "./supabase";
import { searchProperty, launchBrowser } from "./scraper";
import { parseName, buildSearchString } from "./nameParse";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

// ---- Auth middleware ----------------------------------------

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!WORKER_API_KEY) {
    console.warn("[Auth] WORKER_API_KEY not set — allowing all requests (not safe for production)");
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token !== WORKER_API_KEY) {
    console.warn(`[Auth] Rejected request — invalid API key`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ---- Health check ------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "hillsborough-probate-worker",
  });
});

// ---- Match probate properties ------------------------------

async function runMatching(): Promise<{
  totalFetched: number;
  totalProcessed: number;
  matched: number;
  noMatch: number;
  errors: number;
  elapsed: string;
}> {
  const t0 = Date.now();
  console.log("[Worker] ===== START matching run =====");

  // Warm up browser before processing
  console.log("[Worker] Pre-warming Chromium...");
  await launchBrowser();
  console.log("[Worker] Chromium ready");

  // Fetch eligible leads
  const leads = await fetchEligibleLeads();
  console.log(`[Worker] Eligible leads to process: ${leads.length}`);

  let matched = 0;
  let noMatch = 0;
  let errors = 0;
  let skipped = 0;

  // Process sequentially — one lead at a time
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(
      `[Worker] Processing ${i + 1}/${leads.length}: id=${lead.id} case=${lead.case_number} deceased="${lead.deceased_name}"`
    );

    // Parse name
    const parsed = parseName(lead.deceased_name);
    if (!parsed || !parsed.last || parsed.last.length < 2) {
      console.log(`[Worker] SKIP id=${lead.id}: unusable name "${lead.deceased_name}"`);
      await updateMatchStatus(lead.id, "no_match");
      skipped++;
      noMatch++;
      continue;
    }

    const searchStr = buildSearchString(parsed);
    console.log(`[Worker] Search string: "${searchStr}" (last="${parsed.last}" first="${parsed.first}")`);

    try {
      const result = await searchProperty(searchStr, lead.id);

      if (result) {
        console.log(
          `[Worker] ✓ MATCHED id=${lead.id}: "${result.address}, ${result.city}, ${result.state} ${result.zip}"`
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

    // Delay between requests — respectful scraping
    if (i < leads.length - 1) {
      const delay = 2000 + Math.random() * 1000; // 2-3s random delay
      console.log(`[Worker] Waiting ${Math.round(delay)}ms before next lead...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    totalFetched: leads.length,
    totalProcessed: leads.length - skipped,
    matched,
    noMatch,
    errors,
    elapsed: `${elapsed}s`,
  };

  console.log("[Worker] ===== DONE =====", result);
  return result;
}

// Prevent concurrent runs
let isRunning = false;

app.all(
  "/match-probate",
  requireApiKey,
  async (_req: Request, res: Response) => {
    if (isRunning) {
      console.log("[Worker] Already running — rejecting concurrent request");
      res.status(409).json({
        error: "Matching already in progress",
        message: "A matching run is currently active. Please wait for it to complete.",
      });
      return;
    }

    isRunning = true;
    console.log("[Worker] /match-probate triggered");

    try {
      const result = await runMatching();
      res.json({
        success: true,
        ...result,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Worker] Fatal error:", msg);
      res.status(500).json({ success: false, error: msg });
    } finally {
      isRunning = false;
    }
  }
);

// ---- Status endpoint ---------------------------------------

app.get("/status", requireApiKey, (_req: Request, res: Response) => {
  res.json({
    running: isRunning,
    timestamp: new Date().toISOString(),
  });
});

// ---- Start server ------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Worker] ===== Hillsborough Probate Worker =====`);
  console.log(`[Worker] Listening on port ${PORT}`);
  console.log(`[Worker] API key auth: ${WORKER_API_KEY ? "ENABLED" : "DISABLED (set WORKER_API_KEY)"}`);
  console.log(`[Worker] Supabase URL: ${process.env.SUPABASE_URL ?? "NOT SET"}`);
  console.log(`[Worker] Endpoints:`);
  console.log(`[Worker]   GET  /health`);
  console.log(`[Worker]   GET  /status`);
  console.log(`[Worker]   POST /match-probate  (or GET for browser testing)`);
});
