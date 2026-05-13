// ============================================================
// HCPA Property Search Scraper — Playwright browser automation
// ============================================================

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { parseAddressString } from "./nameParse";
import * as fs from "fs";

const HCPA_URL = "https://gis.hcpafl.org/propertysearch/#/nav/Basic%20Search";
const SEARCH_DELAY_MS = 1500;
const RESULT_TIMEOUT = 12000;
const NAV_TIMEOUT = 20000;

export interface PropertyResult {
  address: string;
  city: string;
  state: string;
  zip: string | null;
  rawAddress: string;
}

// ---- Chromium path detection --------------------------------

function findChromiumPath(): string | undefined {
  // Explicit env var always wins
  if (process.env.CHROMIUM_PATH) {
    console.log(`[Browser] CHROMIUM_PATH env: ${process.env.CHROMIUM_PATH}`);
    return process.env.CHROMIUM_PATH;
  }

  // Common paths on Debian/Ubuntu (Railway uses Debian bookworm-slim)
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[Browser] Found Chromium at: ${p}`);
      return p;
    }
  }

  console.warn("[Browser] No system Chromium found — Playwright will use its own");
  return undefined;
}

// ---- Browser lifecycle -------------------------------------

let browser: Browser | null = null;

export async function launchBrowser(): Promise<Browser> {
  if (browser) {
    try {
      // Verify still alive
      const ctx = await browser.newContext();
      await ctx.close();
      return browser;
    } catch {
      console.log("[Browser] Stale browser instance — relaunching");
      browser = null;
    }
  }

  const executablePath = findChromiumPath();
  const isHeadful = process.env.PLAYWRIGHT_HEADFUL === "true";

  console.log(`[Browser] Launching Chromium headless=${!isHeadful} path=${executablePath ?? "playwright-bundled"}`);

  try {
    browser = await chromium.launch({
      headless: !isHeadful,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--single-process",           // required on Railway's constrained containers
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      timeout: 30000,
    });

    console.log("[Browser] ✓ Chromium launched");

    browser.on("disconnected", () => {
      console.warn("[Browser] Chromium disconnected");
      browser = null;
    });

    return browser;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Browser] LAUNCH FAILED: ${msg}`);
    throw new Error(`Failed to launch Chromium: ${msg}. Check that chromium is installed in the Docker image.`);
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    console.log("[Browser] Chromium closed");
  }
}

// ---- Page helpers ------------------------------------------

async function waitForAngular(page: Page, leadId: number): Promise<void> {
  console.log(`[Scraper:L${leadId}] Waiting for Angular...`);
  try {
    await page.waitForSelector("input, button", { timeout: 15000 });
    console.log(`[Scraper:L${leadId}] Angular DOM ready`);
  } catch {
    console.warn(`[Scraper:L${leadId}] Angular wait timed out — continuing`);
  }
  await page.waitForTimeout(1000);
}

// ---- Selectors ---------------------------------------------

const OWNER_INPUT_SELECTORS = [
  'input[placeholder*="owner" i]',
  'input[placeholder*="name" i]',
  'input[ng-model*="owner" i]',
  'input[id*="owner" i]',
  'input[name*="owner" i]',
  'input[aria-label*="owner" i]',
  'input[type="text"]:first-of-type',
  'input[type="search"]',
];

const RESULT_ROW_SELECTORS = [
  "table tbody tr",
  ".search-results tr",
  "[ng-repeat*='result']",
  ".results-list li",
  ".parcel-result",
  "li[class*='result' i]",
  "div[class*='result' i]",
  "tr[class*='result' i]",
];

const ADDRESS_SELECTORS = [
  'td:has-text("Site Address") + td',
  'th:has-text("Site Address") + td',
  'label:has-text("Site Address") + span',
  'label:has-text("Site Address") + div',
  'label:has-text("Property Address") + span',
  'dt:has-text("Site Address") + dd',
  ".site-address",
  ".property-address",
  "[class*='siteAddress' i]",
  "[class*='site-address' i]",
  "[ng-bind*='siteAddr' i]",
  "[ng-bind*='address' i]",
];

async function findElement(
  page: Page,
  selectors: string[],
  label: string,
  leadId: number
): Promise<import("playwright").Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        console.log(`[Scraper:L${leadId}] Found ${label}: "${sel}"`);
        return loc;
      }
    } catch {
      // try next
    }
  }
  console.warn(`[Scraper:L${leadId}] ${label} not found with any selector`);
  return null;
}

// ---- Main scraper ------------------------------------------

export async function searchProperty(
  searchString: string,
  leadId: number
): Promise<PropertyResult | null> {
  console.log(`[Scraper:L${leadId}] ===== START search="${searchString}" =====`);

  const b = await launchBrowser();
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await b.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // Log all console messages from the page for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.log(`[Page:L${leadId}] console.error: ${msg.text()}`);
      }
    });

    // Step 1: Navigate
    console.log(`[Scraper:L${leadId}] Step 1: Navigating to HCPA...`);
    await page.goto(HCPA_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const title = await page.title();
    const url = page.url();
    console.log(`[Scraper:L${leadId}] Step 1: Loaded — title="${title}" url="${url}"`);

    await waitForAngular(page, leadId);

    // Step 2: Find search input
    console.log(`[Scraper:L${leadId}] Step 2: Finding owner input...`);
    const ownerInput = await findElement(page, OWNER_INPUT_SELECTORS, "owner input", leadId);

    if (!ownerInput) {
      const html = (await page.content()).slice(0, 3000);
      console.log(`[Scraper:L${leadId}] Page HTML snapshot:\n${html}`);
      return null;
    }

    // Step 3: Type search
    console.log(`[Scraper:L${leadId}] Step 3: Typing "${searchString}"...`);
    await ownerInput.click({ clickCount: 3 });
    await ownerInput.fill(searchString);
    await page.waitForTimeout(SEARCH_DELAY_MS);

    // Step 4: Submit
    console.log(`[Scraper:L${leadId}] Step 4: Submitting...`);
    await ownerInput.press("Enter");
    await page.waitForTimeout(500);

    // Step 5: Wait for results
    console.log(`[Scraper:L${leadId}] Step 5: Waiting for results...`);
    let resultsFound = false;

    for (const sel of RESULT_ROW_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: RESULT_TIMEOUT });
        const count = await page.locator(sel).count();
        if (count > 0) {
          console.log(`[Scraper:L${leadId}] Step 5: ${count} result(s) via "${sel}"`);
          resultsFound = true;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!resultsFound) {
      const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
      console.log(`[Scraper:L${leadId}] No results. Page text: ${bodyText}`);
      return null;
    }

    // Step 6: Click first result
    console.log(`[Scraper:L${leadId}] Step 6: Clicking first result...`);
    let clicked = false;

    for (const sel of RESULT_ROW_SELECTORS) {
      try {
        const rows = page.locator(sel);
        if ((await rows.count()) > 0) {
          const first = rows.first();
          const rowText = (await first.innerText().catch(() => "")).slice(0, 200);
          console.log(`[Scraper:L${leadId}] First result text: "${rowText}"`);

          const link = first.locator("a").first();
          if ((await link.count()) > 0) {
            await link.click();
          } else {
            await first.click();
          }
          clicked = true;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!clicked) {
      console.log(`[Scraper:L${leadId}] Could not click result`);
      return null;
    }

    // Step 7: Wait for detail page
    console.log(`[Scraper:L${leadId}] Step 7: Waiting for detail page...`);
    await page.waitForTimeout(2500);
    await waitForAngular(page, leadId);
    console.log(`[Scraper:L${leadId}] Detail URL: ${page.url()}`);

    // Step 8: Extract address
    console.log(`[Scraper:L${leadId}] Step 8: Extracting address...`);

    for (const sel of ADDRESS_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0) {
          const rawText = (await el.innerText()).trim();
          console.log(`[Scraper:L${leadId}] Address via "${sel}": "${rawText}"`);
          if (rawText.length > 3) {
            const parsed = parseAddressString(rawText);
            if (parsed.address) {
              console.log(`[Scraper:L${leadId}] MATCHED: addr="${parsed.address}" city="${parsed.city}" zip="${parsed.zip}"`);
              return { address: parsed.address, city: parsed.city ?? "", state: parsed.state, zip: parsed.zip, rawAddress: rawText };
            }
          }
        }
      } catch {
        // try next
      }
    }

    // Fallback: regex scan page text
    const pageText = await page.locator("body").innerText().catch(() => "");
    console.log(`[Scraper:L${leadId}] Detail page text (1500):\n${pageText.slice(0, 1500)}`);

    const addrMatch = pageText.match(/\d+\s+[\w\s.]+,\s+[\w\s]+,\s+[A-Z]{2}\s+\d{5}/);
    if (addrMatch) {
      const raw = addrMatch[0].trim();
      const parsed = parseAddressString(raw);
      if (parsed.address) {
        console.log(`[Scraper:L${leadId}] MATCHED (regex fallback): "${raw}"`);
        return { address: parsed.address, city: parsed.city ?? "", state: parsed.state, zip: parsed.zip, rawAddress: raw };
      }
    }

    console.log(`[Scraper:L${leadId}] no_match — address not found`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper:L${leadId}] EXCEPTION: ${msg}`);
    if (page) {
      console.error(`[Scraper:L${leadId}] URL at error: ${page.url()}`);
      const html = await page.content().catch(() => "");
      console.error(`[Scraper:L${leadId}] HTML at error (1000): ${html.slice(0, 1000)}`);
    }
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    console.log(`[Scraper:L${leadId}] ===== END =====`);
  }
}
