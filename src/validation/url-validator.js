import { chromium } from "playwright";
import { loadDemos } from "../data/demo-loader.js";
import { logger } from "../utils/logger.js";

const MIN_RENDERED_TEXT = 120;

/**
 * Validate URLs with a real browser: a 200 response is not enough when the page
 * is blank, JS-only, or stuck behind a consent wall.
 */
export async function validateUrls(demos = loadDemos()) {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    for (const demo of demos) {
      const page = await context.newPage();
      try {
        const response = await page.goto(demo.base_url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

        const status = response ? response.status() : 0;
        const text = (await page.evaluate(() => document.body?.innerText || ""))
          .replace(/\s+/g, " ").trim();

        const statusOk = status >= 200 && status < 400;
        const contentOk = text.length >= MIN_RENDERED_TEXT;
        const ok = statusOk && contentOk;

        if (ok) {
          logger.info(`${demo.id} ${status} ${text.length} chars ${demo.base_url}`);
        } else {
          failed++;
          const reason = statusOk ? "page rendered almost no text" : "unexpected HTTP status";
          logger.warn(`${demo.id} ${status} ${text.length} chars (${reason}) ${demo.base_url}`);
        }
      } catch (error) {
        failed++;
        logger.error(`${demo.id} ${demo.base_url}: ${error.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  logger.info(`URL validation complete: ${demos.length - failed}/${demos.length} reachable`);
  return failed === 0;
}

