// ============================================================
// Railway Worker — Express HTTP Server
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

// ---- Startup validation ------------------------------------

function validateEnv(): void {
  console.log("[Worker] ===== Environment Check =====");
  console.log(`[Worker] PORT: ${PORT}`);
  console.log(`[Worker] SUPABASE_URL: ${process.env.SUPABASE_URL ? "✓ set" : process.env.NEXT_PUBLIC_SUPABASE_URL ? "✓ set (NEXT_PUBLIC_)" : "✗ MISSING"}`);
  console.log(`[Worker] SUPABASE_SERVICE_ROLE_KEY: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`[Worker] WORKER_API_KEY: ${WORKER_API_KEY ? "✓ set" : "✗ NOT SET (all requests allowed)"}`);
  console.log(`[Worker] PLAYWRIGHT_HEADFUL: ${process.env.PLAYWRIGHT_HEADFUL ?? "false"}`);
  console.log(`[Worker] CHROMIUM_PATH: ${process.env.CHROMIUM_PATH ?? "auto-detect"}`);

  // Log which Chromium binaries exist in container
  const chromiumPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of chromiumPaths) {
    if (fs.existsSync(p)) {
      console.log(`[Worker] Found Chromium binary: ${p}`);
    }
  }

  console.log("[Worker] ===== End Environment Check =====");
}

// ---- Auth middleware ----------------------------------------

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!WORKER_API_KEY) {
    next();
    return;
  }
  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  if (token !== WORKER_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ---- Health ------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "hillsborough-probate-worker",
    env: {
      supabaseUrl: !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
      supabaseKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      apiKey: !!WORKER_API_KEY,
    },
  });
});

// ---- Status ------------------------------------------------

app.get("/status", requireApiKey, (_req: Request, res: Response) => {
  res.json({ running: isRunning, timestamp: new Date().toISOString() });
});

// ---- Matching ----------------------------------------------

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
  console.log("[Worker] ===== START matching run =====");

  console.log("[Worker] Pre-warming Chromium...");
  await launchBrowser();
  console.log("[Worker] Chromium ready");

  const leads = await fetchEligibleLeads();
  console.log(`[Worker] Eligible leads: ${leads.length}`);

  let matched = 0;
  let noMatch = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(`[Worker] ${i + 1}/${leads.length}: id=${lead.id} case=${lead.case_number} deceased="${lead.deceased_name}"`);

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
        console.log(`[Worker] ✓ MATCHED id=${lead.id}: "${result.address}, ${result.city}"`);
        await updateMatchedProperty(lead.id, result.address, result.city, result.state, result.zip);
        matched++;
      } else {
        await updateMatchStatus(lead.id, "no_match");
        noMatch++;
      }
    } catch (err) {
      console.error(`[Worker] ERROR id=${lead.id}:`, err instanceof Error ? err.message : err);
      await updateMatchStatus(lead.id, "error");
      errors++;
    }

    if (i < leads.length - 1) {
      const delay = 2000 + Math.random() * 1000;
      console.log(`[Worker] Waiting ${Math.round(delay)}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = { totalFetched: leads.length, totalProcessed: leads.length - skipped, matched, noMatch, errors, elapsed: `${elapsed}s` };
  console.log("[Worker] ===== DONE =====", result);
  return result;
}

app.all("/match-probate", requireApiKey, async (_req: Request, res: Response) => {
  if (isRunning) {
    res.status(409).json({ error: "Matching already in progress", message: "A matching run is currently active." });
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
    // Close browser after each run to free memory
    await closeBrowser();
  }
});

// ---- Start -------------------------------------------------

validateEnv();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Worker] Listening on port ${PORT}`);
  console.log(`[Worker] Endpoints: GET /health  GET /status  POST /match-probate`);
});
