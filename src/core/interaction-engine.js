import { navigateSafely, coverPage, revealPage } from "./page-loader.js";

const pause = (page, ms) => page.waitForTimeout(Math.max(0, ms));

function normalizePath(value) {
  const trimmed = String(value ?? "/").trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

/**
 * The allowlist is explicit: only these pages may ever be recorded, even if a
 * route is added to the scenario by mistake.
 */
function allowedPathSet(scenario) {
  const configured = Array.isArray(scenario.allowedPaths) && scenario.allowedPaths.length
    ? scenario.allowedPaths
    : (scenario.routes || []).flatMap(route => [route.path, ...(route.aliases || [])]);
  return new Set(configured.map(normalizePath));
}

function routeCandidates(route) {
  return [...new Set([route.path, ...(route.aliases || [])].map(normalizePath))];
}

function toUrl(routePath, baseUrl) {
  return new URL(routePath.replace(/^\//, ""), baseUrl + "/").toString();
}

async function dwellUntil(page, deadlineTs) {
  const remaining = deadlineTs - Date.now();
  if (remaining > 50) await pause(page, remaining);
}

const SCROLL_CSS_ID = "__demo_scroll_reset";

/**
 * The site may force `scroll-behavior: smooth` with !important, which turns every
 * scrollTo into a fresh native animation. Successive calls then cancel each
 * other, producing the uneven lurching that looks like a stutter. A stylesheet
 * with !important is the only reliable way to win that cascade.
 */
async function disableNativeSmoothScroll(page) {
  await page.evaluate(id => {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "html,body{scroll-behavior:auto!important}";
    (document.head || document.documentElement).appendChild(style);
  }, SCROLL_CSS_ID).catch(() => {});
}

/**
 * Scroll the page in one continuous motion.
 *
 * The step size is constant and derived from the achievable frame rate, not from
 * wall-clock easing. Time-based tweening looked uneven because rAF intervals are
 * irregular; a fixed pixel step guarantees that every rendered frame advances the
 * same distance, which is what reads as smooth.
 *
 * `ensureClear` is polled while scrolling; if the viewport becomes obstructed the
 * tween aborts instead of recording a covered page.
 */
async function smoothScroll(page, { durationMs, maxPxPerFrame = 0, ensureClear, pollMs = 600 }) {
  if (durationMs < 400) return { ok: true, aborted: false, frames: 0 };

  await disableNativeSmoothScroll(page);

  let settled = false;
  const tween = page.evaluate(({ duration, maxPxPerFrame }) => new Promise(resolve => {
    const root = document.documentElement;
    const docHeight = Math.max(document.body?.scrollHeight || 0, root.scrollHeight || 0);
    const max = Math.max(0, docHeight - window.innerHeight);
    const from = window.scrollY || 0;
    const distance = max - from;
    window.__demoScrollAbort = false;

    if (Math.abs(distance) < 2) return resolve({ aborted: false, frames: 0 });

    // Sample the real frame cadence first, then size the step for the duration.
    const stamps = [];
    const probe = now => {
      stamps.push(now);
      if (stamps.length < 12) return requestAnimationFrame(probe);

      const gaps = stamps.slice(1).map((s, i) => s - stamps[i]).sort((a, b) => a - b);
      const fps = Math.min(60, Math.max(12, 1000 / gaps[Math.floor(gaps.length / 2)]));

      // A heavy page may only manage ~12 fps; a large step then reads as a jump.
      // Cap the distance covered per rendered frame and let the scroll take longer.
      let frames = Math.max(2, Math.round((duration / 1000) * fps));
      if (maxPxPerFrame > 0) {
        frames = Math.max(frames, Math.ceil(Math.abs(distance) / maxPxPerFrame));
      }
      const step = distance / frames;

      let i = 0;
      const advance = () => {
        if (window.__demoScrollAbort) return resolve({ aborted: true, frames: i });
        i += 1;
        window.scrollTo(0, Math.round(from + step * i));
        if (i < frames) requestAnimationFrame(advance);
        else resolve({ aborted: false, frames, fps });
      };
      requestAnimationFrame(advance);
    };
    requestAnimationFrame(probe);
  }), { duration: durationMs, maxPxPerFrame }).then(result => { settled = true; return result; });

  while (!settled) {
    await pause(page, pollMs);
    if (settled) break;
    if (ensureClear && !(await ensureClear())) {
      await page.evaluate(() => { window.__demoScrollAbort = true; }).catch(() => {});
    }
  }

  const result = await tween.catch(() => ({ aborted: true, frames: 0 }));
  return { ok: !result.aborted, aborted: result.aborted, frames: result.frames, fps: result.fps };
}

/** Vertical distance the page can scroll, in CSS pixels. */
async function scrollableDistance(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const height = Math.max(document.body?.scrollHeight || 0, root.scrollHeight || 0);
    return Math.max(0, height - window.innerHeight);
  }).catch(() => 0);
}

async function tryDesktopHover(page, budgetMs = 1500) {
  const deadline = Date.now() + budgetMs;
  const selectors = ["header nav a", "header a", "nav a", "[role='navigation'] a"];
  for (const selector of selectors) {
    if (Date.now() >= deadline) break;
    const links = page.locator(selector);
    const count = await links.count().catch(() => 0);
    if (!count) continue;
    const first = links.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    await first.hover({ timeout: Math.max(500, Math.min(1500, deadline - Date.now())) }).catch(() => {});
    await pause(page, 500);
    return true;
  }
  return false;
}

/**
 * Only real navigation toggles are considered. A bare `button` fallback used to
 * click unrelated controls (form submits, cookie banners) and polluted the video.
 */
const MOBILE_MENU_SELECTORS = [
  "button[aria-label*='menu' i]",
  "button[aria-label*='navigation' i]",
  "[data-testid*='menu' i]",
  "[data-testid*='hamburger' i]",
  "[role='button'][aria-expanded]",
  "header button[aria-expanded]"
];

/**
 * Count links that are actually inside the viewport. Off-canvas menu panels keep
 * a real size and pass a naive visibility check, which made open/close
 * detection unreliable.
 */
async function visibleLinkCount(page) {
  return page.evaluate(() => [...document.querySelectorAll("a[href]")].filter(link => {
    const rect = link.getBoundingClientRect();
    const style = window.getComputedStyle(link);
    if (rect.width === 0 || rect.height === 0) return false;
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  }).length).catch(() => 0);
}

/**
 * Prefer the toggle's own aria-expanded flag; fall back to comparing how many
 * links are on screen before and after the click.
 */
async function menuOpened(page, toggle, baselineLinks) {
  const expanded = await toggle.getAttribute("aria-expanded").catch(() => null);
  if (expanded === "true") return true;
  if (expanded === "false") return false;
  return (await visibleLinkCount(page)) > baselineLinks;
}

const CLOSE_SELECTORS = [
  "button[aria-label*='close' i]",
  "[role='button'][aria-label*='close' i]",
  "[data-testid*='close' i]",
  "button:has-text('Close')",
  "button[aria-label='×']"
];

async function clickCloseControl(page, baselineLinks) {
  for (const selector of CLOSE_SELECTORS) {
    const control = page.locator(selector).first();
    if (!(await control.count().catch(() => 0))) continue;
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click({ timeout: 900 }).catch(() => {});
    await pause(page, 400);
    if ((await visibleLinkCount(page)) <= baselineLinks) return true;
  }
  return false;
}

async function tryMobileMenu(page, budgetMs = 2600) {
  const deadline = Date.now() + budgetMs;
  const baselineLinks = await visibleLinkCount(page);

  for (const selector of MOBILE_MENU_SELECTORS) {
    if (Date.now() >= deadline) return { status: "budget-exhausted", close: null };

    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      if (Date.now() >= deadline) return { status: "budget-exhausted", close: null };

      const item = items.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;

      const box = await item.boundingBox().catch(() => null);
      // Navigation toggles live in the top bar, not halfway down the page.
      if (box && box.y > 240) continue;

      const label = [
        (await item.getAttribute("aria-label").catch(() => "")) || "",
        (await item.innerText().catch(() => "")) || ""
      ].join(" ").trim();
      const looksLikeToggle = /menu|navigation|nav|open|close/i.test(label) || selector.includes("data-testid");
      const isIconOnly = label.length <= 40;
      if (!looksLikeToggle && !isIconOnly) continue;

      await item.click({ timeout: Math.max(400, Math.min(1200, deadline - Date.now())) }).catch(() => {});
      await pause(page, 700);

      if (!(await menuOpened(page, item, baselineLinks))) return { status: "no-effect", close: null };

      return {
        status: "opened",
        isOpen: async () => {
          const expanded = await item.getAttribute("aria-expanded").catch(() => null);
          if (expanded === "true") return true;
          if (expanded === "false") return false;
          return (await visibleLinkCount(page)) > baselineLinks;
        },
        // The open menu covers the page, so it must be dismissed to keep the
        // rest of the recording useful.
        close: async () => {
          if (await clickCloseControl(page, baselineLinks)) return "closed";

          if (await item.isVisible().catch(() => false)) {
            await item.click({ timeout: 900 }).catch(() => {});
            await pause(page, 500);
            const expanded = await item.getAttribute("aria-expanded").catch(() => null);
            if (expanded === "false") return "closed";
            if ((await visibleLinkCount(page)) <= baselineLinks) return "closed";
          }

          await page.keyboard.press("Escape").catch(() => {});
          await pause(page, 400);
          return (await visibleLinkCount(page)) <= baselineLinks ? "closed" : "still-open";
        }
      };
    }
  }
  return { status: "not-found", close: null };
}

/**
 * The mobile drawer covers the viewport, so any scroll recorded while it is open
 * shows nothing but the menu. Close it and verify before scrolling.
 */
async function ensureDrawerClosed(page, drawer) {
  if (!drawer || typeof drawer.isOpen !== "function") return true;
  if (!(await drawer.isOpen())) return true;

  await drawer.close();
  if (!(await drawer.isOpen())) return true;

  // Last resort: a reload drops any leftover overlay state.
  await page.keyboard.press("Escape").catch(() => {});
  await pause(page, 300);
  return !(await drawer.isOpen());
}

async function tryPrimaryCta(page) {
  const candidates = [
    "a[href*='contact' i]", "a[href^='tel:']",
    "a:has-text('Get a Quote')", "a:has-text('Contact')", "button:has-text('Contact')"
  ];
  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if (!(await target.count().catch(() => 0))) continue;
    await target.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
    await target.hover({ timeout: 1000 }).catch(() => {});
    await pause(page, 700);
    return true;
  }
  return false;
}

export async function runWalkthrough(page, demo, scenario, videoConfig, device) {
  const events = [];
  const startedAt = Date.now();
  const record = (action, result = "ok") =>
    events.push({ device, action, result, t: ((Date.now() - startedAt) / 1000).toFixed(1) + "s", at: new Date().toISOString() });

  const interactions = scenario.interactions || {};
  const routes = scenario.routes || [];
  const allowed = allowedPathSet(scenario);
  const durationMs = (videoConfig.durationSeconds || 60) * 1000;
  const closingMs = Math.max(0, (scenario.closingSeconds || 0) * 1000);
  // Reserve the outro so the last frame is not the only thing the composer trims.
  const captureDeadline = startedAt + durationMs - closingMs;
  let visitedAny = false;
  let drawer = null;

  for (const [index, route] of routes.entries()) {
    const remainingOverall = captureDeadline - Date.now();
    if (remainingOverall < 2000) {
      record(`skip:${route.path}`, "deadline");
      continue;
    }

    // Only whitelisted pages may ever reach the recording.
    const candidates = routeCandidates(route).filter(candidate => allowed.has(candidate));
    if (!candidates.length) {
      record(`skip:${route.path}`, "not-allowed");
      continue;
    }

    const capture = videoConfig.capture || {};
    const openingMs = index === 0 ? (scenario.openingSeconds || 0) * 1000 : 0;
    const pendingAfter = Math.max(0, routes.length - index - 1);

    // Navigation must not eat the minimum screen time owed to the routes that
    // are still queued.
    const navCeiling = capture.maxNavigationBudgetMs || 15000;
    const navFloor = (capture.minDwellMs || 9000) * pendingAfter;
    const navBudget = Math.max(4000, Math.min(navCeiling, captureDeadline - Date.now() - navFloor - 2000));

    let nav = { ok: false, error: "not attempted" };
    let activePath = null;
    const sceneFadeMs = videoConfig.transitions?.sceneFadeMs ?? 420;

    for (const candidate of candidates) {
      if (captureDeadline - Date.now() < 2000) break;
      // Dissolve the outgoing page before the document is replaced, so the cut
      // is a fade through the canvas colour instead of a hard jump.
      await coverPage(page, sceneFadeMs);
      nav = await navigateSafely(page, toUrl(candidate, demo.base_url), videoConfig, navBudget);
      if (nav.ok) {
        activePath = candidate;
        break;
      }
      // Blank, still-loading, 404, or unreachable pages are never recorded.
      record(`skip:${candidate}`, nav.error || "failed");
    }

    if (!nav.ok) continue;
    record(`navigate:${activePath}`, `ok ${nav.textLength ?? 0} chars`);
    visitedAny = true;
    if (activePath !== "/") drawer = null;

    // The budget is measured from when the page is actually on screen, and it is
    // capped by what this page can consume: holding the top, one continuous
    // scroll, and holding the bottom. Time a short page cannot use rolls over to
    // the pages that come after it instead of becoming dead air.
    const routeStart = Date.now();
    const holdTopTarget = capture.holdTopMs ?? 3000;
    const holdBottomTarget = capture.holdBottomMs ?? 2500;
    const maxScrollMs = capture.maxScrollMs ?? 25000;
    const minScrollMs = capture.minScrollMs ?? 6000;
    const scrollSpeed = capture.scrollSpeedPxPerSecond ?? 500;
    // Pace the scroll by how much page there is to cover, not by a fixed clock,
    // so short pages are not stretched and long pages are not rushed.
    const distance = await scrollableDistance(page);
    const plannedScrollMs = Math.max(minScrollMs, Math.min(maxScrollMs, Math.round((distance / scrollSpeed) * 1000)));
    // The home page also runs a hover or a drawer demo before it scrolls. That
    // time is charged to the same budget, so without reserving it the scroll gets
    // squeezed and pans faster than every other page.
    const interactionReserveMs = index !== 0 ? 0
      : device === "desktop" ? (interactions.desktopHoverNavigation ? 1600 : 0)
      : (interactions.mobileOpenNavigation ? 5000 : 0);
    const consumableMs = openingMs + interactionReserveMs + holdTopTarget + plannedScrollMs + holdBottomTarget;

    const remainingRoutes = routes.slice(index);
    const remainingWeight = remainingRoutes.reduce((sum, item) => sum + (item.seconds || 5), 0);
    const navReserve = (capture.estimatedNavigationMs || 6000) * pendingAfter;
    const pool = Math.max(4000, captureDeadline - Date.now() - navReserve);
    const shareMs = Math.floor((pool * (route.seconds || 5)) / remainingWeight);
    const routeBudgetMs = Math.max(Math.min(consumableMs, 3000), Math.min(shareMs, consumableMs));

    const routeDeadline = Math.min(routeStart + routeBudgetMs, captureDeadline);

    const isHome = activePath === "/";
    const remainingDwell = () => Math.min(routeDeadline - Date.now(), captureDeadline - Date.now());

    if (isHome && scenario.openingSeconds) {
      await pause(page, scenario.openingSeconds * 1000);
      record("opening-hold");
    }

    // Hold the top of every page before moving, so the hero is actually read
    // instead of scrolling away from it immediately.
    const holdTopMs = Math.min(holdTopTarget, Math.max(0, remainingDwell() * 0.4));
    if (holdTopMs > 300) {
      await pause(page, holdTopMs);
      record("hold-top", `${(holdTopMs / 1000).toFixed(1)}s`);
    }

    // Hover and the drawer are nice-to-have; scrolling the page is the point.
    // Both are skipped when they would leave no time to scroll.
    if (isHome && device === "desktop" && interactions.desktopHoverNavigation) {
      const budget = Math.min(1400, remainingDwell() - 3000);
      record("hover-navigation", budget > 400 ? ((await tryDesktopHover(page, budget)) ? "ok" : "not-found") : "skipped:budget");
    }

    if (isHome && device === "mobile" && interactions.mobileOpenNavigation) {
      const budget = Math.min(2600, remainingDwell() - 3500);
      if (budget > 500) {
        const menu = await tryMobileMenu(page, budget);
        record("mobile-menu", menu.status);
        if (menu.status === "opened") {
          drawer = menu;
          await pause(page, 800);
          record("mobile-menu-close", await menu.close());
        }
      } else {
        record("mobile-menu", "skipped:budget");
      }
    }

    if (interactions.scroll) {
      // Never record a scroll while the drawer covers the viewport.
      if (!(await ensureDrawerClosed(page, drawer))) {
        record("scroll-skipped", "drawer-still-open");
      } else {
        // Leave time at the bottom so the last screen is seen, not skipped past.
        const holdBottomMs = Math.min(holdBottomTarget, Math.max(0, remainingDwell() - 1500));
        const scrollMs = Math.min(plannedScrollMs, Math.max(1500, remainingDwell() - holdBottomMs));

        const scrolled = await smoothScroll(page, {
          durationMs: scrollMs,
          maxPxPerFrame: capture.maxPxPerFrame ?? 45,
          ensureClear: drawer ? () => ensureDrawerClosed(page, drawer) : null
        });
        record(
          "scroll-page",
          scrolled.ok
            ? `ok ${(scrollMs / 1000).toFixed(1)}s / ${scrolled.frames} frames @ ${Math.round(scrolled.fps || 0)}fps`
            : "aborted:viewport-obstructed"
        );
      }
    }

    if ((activePath === "/contact" || activePath === "/request-a-quote") && interactions.clickPrimaryCta && remainingDwell() > 800) {
      record(`highlight-cta:${activePath}`, (await tryPrimaryCta(page)) ? "ok" : "not-found");
    }

    // Hold the final screen of the page for the rest of its budget.
    const bottomHoldMs = remainingDwell();
    if (bottomHoldMs > 300) {
      record("hold-bottom", `${(bottomHoldMs / 1000).toFixed(1)}s`);
      await dwellUntil(page, routeDeadline);
    }
  }

  if (visitedAny) {
    // Stay on the last screen for the outro instead of snapping back to the top.
    const remaining = startedAt + durationMs - Date.now();
    if (remaining > 0) {
      await pause(page, remaining);
      record("closing-hold");
    }
  }

  return events;
}
