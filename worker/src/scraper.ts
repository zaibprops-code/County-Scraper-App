// ============================================================
// HCPA Property Search Scraper — Playwright browser automation
//
// Navigates https://gis.hcpafl.org/propertysearch/ like a real
// browser, searches by owner name, and extracts the property
// address from the first matching result.
//
// Search format: "LASTNAME, FIRSTNAME"  e.g. "BREESE, EVA"
// ============================================================

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { parseAddressString } from "./nameParse";

const HCPA_URL = "https://gis.hcpafl.org/propertysearch/#/nav/Basic%20Search";
const SEARCH_DELAY_MS = 1500;  // wait after typing before submitting
const RESULT_TIMEOUT = 12000;  // ms to wait for results to appear
const NAV_TIMEOUT = 20000;     // ms to wait for page navigation

export interface PropertyResult {
  address: string;
  city: string;
  state: string;
  zip: string | null;
  rawAddress: string;
}

// ---- Browser lifecycle -------------------------------------

let browser: Browser | null = null;

export async function launchBrowser(): Promise<Browser> {
  if (browser) return browser;

  const isHeadful = process.env.PLAYWRIGHT_HEADFUL === "true";
  const chromiumPath = process.env.CHROMIUM_PATH;

  console.log(`[Browser] Launching Chromium headless=${!isHeadful}`);
  if (chromiumPath) console.log(`[Browser] Using system Chromium: ${chromiumPath}`);

  browser = await chromium.launch({
    headless: !isHeadful,
    executablePath: chromiumPath || undefined,
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
    ],
  });

  console.log("[Browser] Chromium launched successfully");

  browser.on("disconnected", () => {
    console.log("[Browser] Chromium disconnected — will relaunch on next request");
    browser = null;
  });

  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    console.log("[Browser] Chromium closed");
  }
}

// ---- Page helpers ------------------------------------------

async function waitForAngular(page: Page, leadId: number): Promise<void> {
  console.log(`[Scraper:L${leadId}] Waiting for Angular app to initialize...`);
  // Wait for any input or button to appear — Angular SPA takes time
  try {
    await page.waitForSelector("input, button", { timeout: 15000 });
    console.log(`[Scraper:L${leadId}] Angular DOM ready`);
  } catch {
    console.warn(`[Scraper:L${leadId}] Timed out waiting for Angular — continuing anyway`);
  }
  // Extra small delay for Angular rendering
  await page.waitForTimeout(800);
}

async function takeDebugScreenshot(page: Page, leadId: number, label: string): Promise<void> {
  // Only take screenshots if explicitly enabled — avoids memory issues on Railway
  if (process.env.DEBUG_SCREENSHOTS !== "true") return;
  try {
    const path = `/tmp/debug-L${leadId}-${label}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`[Scraper:L${leadId}] Screenshot saved: ${path}`);
  } catch {
    // Non-critical
  }
}

// ---- Search selectors (try in order) -----------------------

// Owner name input candidates for the Angular SPA
const OWNER_INPUT_SELECTORS = [
  'input[placeholder*="owner" i]',
  'input[placeholder*="name" i]',
  'input[ng-model*="owner" i]',
  'input[id*="owner" i]',
  'input[name*="owner" i]',
  'input[aria-label*="owner" i]',
  'input[type="text"][class*="owner" i]',
  // Generic fallbacks
  'input[type="text"]:first-of-type',
  'input[type="search"]',
];

// Search submit button candidates
const SEARCH_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Search")',
  'button:has-text("search")',
  'input[type="submit"]',
  'button[class*="search" i]',
  'button[ng-click*="search" i]',
];

// Result row candidates (list of matching parcels)
const RESULT_ROW_SELECTORS = [
  "table tbody tr",
  ".search-results tr",
  ".result-row",
  "[ng-repeat*='result'] ",
  ".results-list li",
  ".parcel-result",
  "li[class*='result' i]",
  "div[class*='result' i]",
];

// Property address on detail page
const ADDRESS_SELECTORS = [
  // Label/value pairs
  'td:has-text("Site Address") + td',
  'th:has-text("Site Address") + td',
  'label:has-text("Site Address") + *',
  'label:has-text("Property Address") + *',
  'dt:has-text("Site Address") + dd',
  // CSS class based
  '.site-address',
  '.property-address',
  '[class*="site-address" i]',
  '[class*="siteAddress" i]',
  '[class*="physAddress" i]',
  // Angular binding
  '[ng-bind*="address" i]',
  '[ng-bind*="siteAddr" i]',
];

// ---- Find element with fallback list -----------------------

async function findElement(
  page: Page,
  selectors: string[],
  label: string,
  leadId: number
): Promise<import("playwright").Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0) {
        console.log(`[Scraper:L${leadId}] Found ${label} with selector: "${sel}"`);
        return loc;
      }
    } catch {
      // try next
    }
  }
  console.warn(`[Scraper:L${leadId}] Could not find ${label} with any selector`);
  return null;
}

// ---- Main scraper function ---------------------------------

export async function searchProperty(
  searchString: string,
  leadId: number
): Promise<PropertyResult | null> {
  console.log(`[Scraper:L${leadId}] ===== START search="${searchString}" =====`);

  const b = await launchBrowser();
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Fresh browser context per lead — no cookie contamination
    context = await b.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // ---- Step 1: Navigate to HCPA property search ----
    console.log(`[Scraper:L${leadId}] Step 1: Navigating to ${HCPA_URL}`);
    await page.goto(HCPA_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    console.log(`[Scraper:L${leadId}] Step 1: Page loaded — title="${await page.title()}"`);

    await waitForAngular(page, leadId);
    await takeDebugScreenshot(page, leadId, "01-loaded");

    // ---- Step 2: Find the owner name search input ----
    console.log(`[Scraper:L${leadId}] Step 2: Looking for owner name input`);
    const ownerInput = await findElement(page, OWNER_INPUT_SELECTORS, "owner input", leadId);

    if (!ownerInput) {
      // Log page HTML to help debug selector issues
      const html = await page.content();
      console.log(`[Scraper:L${leadId}] Page HTML (first 2000):\n${html.slice(0, 2000)}`);
      console.log(`[Scraper:L${leadId}] ABORT — no search input found`);
      return null;
    }

    // ---- Step 3: Type search string ----
    console.log(`[Scraper:L${leadId}] Step 3: Typing search string "${searchString}"`);
    await ownerInput.click({ clickCount: 3 }); // select all first
    await ownerInput.fill(searchString);
    console.log(`[Scraper:L${leadId}] Step 3: Typed "${searchString}"`);

    await page.waitForTimeout(SEARCH_DELAY_MS);
    await takeDebugScreenshot(page, leadId, "02-typed");

    // ---- Step 4: Submit search ----
    console.log(`[Scraper:L${leadId}] Step 4: Submitting search`);

    // Try pressing Enter first (fastest)
    await ownerInput.press("Enter");
    console.log(`[Scraper:L${leadId}] Step 4: Pressed Enter`);

    // Fallback: click Search button if available
    const searchBtn = await findElement(page, SEARCH_BUTTON_SELECTORS, "search button", leadId);
    if (searchBtn) {
      try {
        await searchBtn.click();
        console.log(`[Scraper:L${leadId}] Step 4: Also clicked Search button`);
      } catch {
        console.log(`[Scraper:L${leadId}] Step 4: Search button click skipped (not needed)`);
      }
    }

    // ---- Step 5: Wait for results ----
    console.log(`[Scraper:L${leadId}] Step 5: Waiting for results...`);

    let resultsFound = false;
    for (const resultSel of RESULT_ROW_SELECTORS) {
      try {
        await page.waitForSelector(resultSel, { timeout: RESULT_TIMEOUT });
        const count = await page.locator(resultSel).count();
        if (count > 0) {
          console.log(`[Scraper:L${leadId}] Step 5: Found ${count} result row(s) with "${resultSel}"`);
          resultsFound = true;
          break;
        }
      } catch {
        // try next selector
      }
    }

    if (!resultsFound) {
      // Log what IS on the page
      const bodyText = await page.locator("body").innerText().catch(() => "");
      console.log(`[Scraper:L${leadId}] Step 5: No results found. Page text (500): ${bodyText.slice(0, 500)}`);
      await takeDebugScreenshot(page, leadId, "03-no-results");
      console.log(`[Scraper:L${leadId}] RESULT: no_match — no results returned`);
      return null;
    }

    await takeDebugScreenshot(page, leadId, "04-results");

    // ---- Step 6: Click first result ----
    console.log(`[Scraper:L${leadId}] Step 6: Clicking first result`);

    let clicked = false;
    for (const resultSel of RESULT_ROW_SELECTORS) {
      try {
        const rows = page.locator(resultSel);
        if (await rows.count() > 0) {
          const firstRow = rows.first();
          // Log what the first result shows
          const rowText = await firstRow.innerText().catch(() => "");
          console.log(`[Scraper:L${leadId}] Step 6: First result text: "${rowText.slice(0, 200)}"`);

          // Try clicking a link inside the row, or the row itself
          const link = firstRow.locator("a").first();
          if (await link.count() > 0) {
            await link.click();
            console.log(`[Scraper:L${leadId}] Step 6: Clicked link in first result row`);
          } else {
            await firstRow.click();
            console.log(`[Scraper:L${leadId}] Step 6: Clicked first result row directly`);
          }
          clicked = true;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!clicked) {
      console.log(`[Scraper:L${leadId}] Step 6: Could not click any result row`);
      return null;
    }

    // ---- Step 7: Wait for detail page ----
    console.log(`[Scraper:L${leadId}] Step 7: Waiting for detail page...`);
    await page.waitForTimeout(2000); // Angular route transition
    await waitForAngular(page, leadId);
    await takeDebugScreenshot(page, leadId, "05-detail");

    console.log(`[Scraper:L${leadId}] Step 7: Detail page URL: ${page.url()}`);

    // ---- Step 8: Extract property address ----
    console.log(`[Scraper:L${leadId}] Step 8: Extracting property address`);

    for (const addrSel of ADDRESS_SELECTORS) {
      try {
        const el = page.locator(addrSel).first();
        if (await el.count() > 0) {
          const rawText = (await el.innerText()).trim();
          console.log(`[Scraper:L${leadId}] Step 8: Found address with "${addrSel}": "${rawText}"`);

          if (rawText && rawText.length > 3) {
            const parsed = parseAddressString(rawText);
            console.log(`[Scraper:L${leadId}] Step 8: Parsed → addr="${parsed.address}" city="${parsed.city}" state="${parsed.state}" zip="${parsed.zip}"`);

            if (parsed.address) {
              console.log(`[Scraper:L${leadId}] RESULT: MATCHED`);
              return {
                address: parsed.address,
                city: parsed.city ?? "",
                state: parsed.state,
                zip: parsed.zip,
                rawAddress: rawText,
              };
            }
          }
        }
      } catch {
        // try next selector
      }
    }

    // Fallback: look for any text containing a zip code pattern on the page
    console.log(`[Scraper:L${leadId}] Step 8: Structured selectors failed — scanning page for address`);
    const pageText = await page.locator("body").innerText().catch(() => "");
    console.log(`[Scraper:L${leadId}] Detail page text (first 1500):\n${pageText.slice(0, 1500)}`);

    // Look for lines that look like "123 MAIN ST, TAMPA, FL 33601"
    const addrPattern = /\d+\s+[\w\s.]+,\s+[\w\s]+,\s+[A-Z]{2}\s+\d{5}/g;
    const addrMatches = pageText.match(addrPattern);
    if (addrMatches && addrMatches.length > 0) {
      const rawText = addrMatches[0].trim();
      console.log(`[Scraper:L${leadId}] Step 8: Pattern match found: "${rawText}"`);
      const parsed = parseAddressString(rawText);
      if (parsed.address) {
        console.log(`[Scraper:L${leadId}] RESULT: MATCHED (pattern fallback)`);
        return {
          address: parsed.address,
          city: parsed.city ?? "",
          state: parsed.state,
          zip: parsed.zip,
          rawAddress: rawText,
        };
      }
    }

    console.log(`[Scraper:L${leadId}] RESULT: no_match — address not found on detail page`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper:L${leadId}] EXCEPTION: ${msg}`);
    if (page) {
      const url = page.url();
      console.error(`[Scraper:L${leadId}] Page URL at error: ${url}`);
      const html = await page.content().catch(() => "");
      console.error(`[Scraper:L${leadId}] Page HTML at error (first 1000): ${html.slice(0, 1000)}`);
    }
    throw err;
  } finally {
    if (context) {
      await context.close();
      console.log(`[Scraper:L${leadId}] Browser context closed`);
    }
    console.log(`[Scraper:L${leadId}] ===== END =====`);
  }
}
