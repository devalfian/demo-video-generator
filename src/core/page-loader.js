const CONSENT_PATTERN = /^(accept|accept all|accept cookies|agree|i agree|allow all|got it|ok|okay)$/i;

/**
 * Markers that mean "this is an error page, not the page we asked for".
 * Matched against the title and the start of the rendered text only, so normal
 * body copy mentioning an error does not trigger a false positive.
 */
const ERROR_PAGE_PATTERNS = [
  /\b404\b/,
  /\bnot found\b/i,
  /\bpage not found\b/i,
  /\bsomething went wrong\b/i,
  /\boops\b/i,
  /\bpage (?:does not|doesn't) exist\b/i,
  /\berror\s*(?:4\d\d|5\d\d)\b/i
];

const ERROR_PAGE_HEADLINE_CHARS = 400;

const TRANSITION_LAYER_ID = "__demo_scene_layer";

/**
 * A page change is painted by the browser in a single frame, which reads as a
 * jump cut in the recording. This installs a full-viewport layer that exists in
 * every document from document-start, opaque, and is faded out once the page is
 * ready. Navigations then dissolve through the canvas colour instead of cutting.
 */
export async function installTransitionLayer(page, { color = "#111827", fadeMs = 420 } = {}) {
  await page.addInitScript(({ id, color, fadeMs }) => {
    const ensure = () => {
      if (document.getElementById(id)) return true;
      if (!document.documentElement) return false;

      const layer = document.createElement("div");
      layer.id = id;
      layer.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "pointer-events:none", `background:${color}`,
        "opacity:1", `transition:opacity ${fadeMs}ms ease-in-out`
      ].join(";");

      document.documentElement.appendChild(layer);
      window.__demoScene = {
        hide(ms) {
          layer.style.transitionDuration = `${ms}ms`;
          layer.style.opacity = "0";
          return new Promise(resolve => setTimeout(() => resolve(true), ms + 50));
        },
        show(ms) {
          layer.style.transitionDuration = `${ms}ms`;
          layer.style.opacity = "1";
          return new Promise(resolve => setTimeout(() => resolve(true), ms + 50));
        }
      };
      return true;
    };

    if (!ensure()) {
      const observer = new MutationObserver(() => { if (ensure()) observer.disconnect(); });
      observer.observe(document, { childList: true, subtree: true });
    }
  }, { id: TRANSITION_LAYER_ID, color, fadeMs });
}

/**
 * Expensive paint effects (will-change layers, filters, backdrop blur) make the
 * page drop to ~20 fps while scrolling, which is below the video frame rate and
 * shows up as judder. Neutralising them lifts scrolling well above 25 fps.
 */
export async function installPaintCostReducer(page) {
  await page.addInitScript(() => {
    const css = "*,*::before,*::after{" +
      "will-change:auto!important;" +
      "filter:none!important;" +
      "backdrop-filter:none!important;" +
      "}";

    const apply = () => {
      if (!document.documentElement || document.getElementById("__demo_paint_cost")) return true;
      const style = document.createElement("style");
      style.id = "__demo_paint_cost";
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      return true;
    };

    if (!apply()) {
      const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
      observer.observe(document, { childList: true, subtree: true });
    }
  });
}

/** Fade the current page out to the canvas colour before a navigation. */
export async function coverPage(page, fadeMs = 420) {
  const state = await page.evaluate(({ id, ms }) => {
    const layer = document.getElementById(id);
    if (!layer) return "missing";
    if (Number(getComputedStyle(layer).opacity) >= 0.99) return "already";
    layer.style.transitionDuration = `${ms}ms`;
    layer.style.transitionTimingFunction = "ease-in-out";
    layer.style.opacity = "1";
    return "fading";
  }, { id: TRANSITION_LAYER_ID, ms: fadeMs }).catch(() => "missing");

  if (state === "fading") await page.waitForTimeout(fadeMs);
  return state !== "missing";
}

/** Fade the freshly loaded page in. Safe to call when the layer is missing. */
export async function revealPage(page, fadeMs = 420) {
  return page.evaluate(ms => (window.__demoScene ? window.__demoScene.hide(ms) : false), fadeMs).catch(() => false);
}

/**
 * Best-effort dismissal of cookie/consent banners so they do not cover the
 * viewport for the whole recording. Only exact-match labels are clicked.
 */
async function dismissConsent(page) {
  // One round-trip to locate a plausible consent button, then a single click.
  const candidate = await page.evaluate(pattern => {
    const regex = new RegExp(pattern, "i");
    const buttons = [...document.querySelectorAll("button, [role='button']")];
    for (const button of buttons) {
      const label = (button.innerText || "").replace(/\s+/g, " ").trim();
      if (!regex.test(label)) continue;
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      if (rect.width === 0 || rect.height === 0) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      button.setAttribute("data-demo-consent", "1");
      return label;
    }
    return null;
  }, CONSENT_PATTERN.source).catch(() => null);

  if (!candidate) return false;

  await page.locator("[data-demo-consent='1']").first().click({ timeout: 1500 }).catch(() => {});
  await page.evaluate(() => document.querySelector("[data-demo-consent='1']")?.removeAttribute("data-demo-consent")).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

/**
 * Decide whether the page is worth recording.
 *
 * A page is rejected when it is an error page, still rendering a blank shell, or
 * never stops changing. Content length is polled until it holds steady, which is
 * the practical signal that client-side rendering and lazy sections finished.
 */
export async function inspectPage(page, config) {
  const capture = config.capture || {};
  const minChars = capture.minRenderedChars ?? 200;
  const stabilityMs = capture.contentStabilityMs ?? 350;
  const timeoutMs = capture.contentReadyTimeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;

  let snapshot = null;
  let lastLength = -1;
  let stableReads = 0;

  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const main = document.querySelector("main, [role='main'], #main");
      const rect = main ? main.getBoundingClientRect() : null;
      return {
        text,
        title: document.title || "",
        mainHeight: rect ? Math.round(rect.height) : 0,
        busy: !!document.querySelector("[aria-busy='true']")
      };
    }).catch(() => null);

    if (!snapshot) return { ok: false, reason: "page became unreadable" };

    if (snapshot.text.length === lastLength) stableReads++;
    else {
      lastLength = snapshot.text.length;
      stableReads = 0;
    }

    if (stableReads >= 1 && !snapshot.busy) break;
    await page.waitForTimeout(stabilityMs);
  }

  if (!snapshot) return { ok: false, reason: "page became unreadable" };

  const headline = snapshot.text.slice(0, ERROR_PAGE_HEADLINE_CHARS);
  const errorMarker = ERROR_PAGE_PATTERNS.find(pattern => pattern.test(snapshot.title) || pattern.test(headline));
  if (errorMarker) {
    return { ok: false, reason: `error page (matched ${errorMarker})`, textLength: snapshot.text.length };
  }

  if (snapshot.text.length < minChars) {
    return {
      ok: false,
      reason: `blank or unfinished page (${snapshot.text.length} chars, minimum ${minChars})`,
      textLength: snapshot.text.length
    };
  }

  if (snapshot.busy) {
    return { ok: false, reason: "page still busy loading", textLength: snapshot.text.length };
  }

  return { ok: true, textLength: snapshot.text.length, title: snapshot.title };
}

export async function navigateSafely(page, url, config, timeoutOverrideMs) {
  const capture = config.capture || {};
  const timeout = timeoutOverrideMs ?? capture.navigationTimeoutMs ?? 30000;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // `commit` returns as soon as the navigation is accepted. Waiting for
      // domcontentloaded here was the source of long, opaque timeouts on slow
      // sites; parsing is bounded explicitly below instead.
      const response = await page.goto(url, { waitUntil: "commit", timeout });
      const status = response ? response.status() : 0;
      if (status >= 400) return { ok: false, error: `HTTP ${status}` };

      await page
        .waitForFunction(() => document.readyState !== "loading", null, { timeout })
        .catch(() => {});

      await page.waitForLoadState("networkidle", { timeout: capture.networkIdleTimeoutMs ?? 800 }).catch(() => {});
      await page.waitForTimeout(capture.settleAfterNavigationMs ?? 700);
      await dismissConsent(page);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});

      const inspection = await inspectPage(page, config);
      if (!inspection.ok) return { ok: false, error: inspection.reason, textLength: inspection.textLength };

      // The page is fully rendered, so the opaque transition layer can dissolve.
      await revealPage(page, config.transitions?.sceneFadeMs ?? 420);

      return { ok: true, status: page.url(), textLength: inspection.textLength };
    } catch (error) {
      // A previous slow navigation can land while this one is starting. Retrying
      // once settles it; anything else is a real failure.
      const interrupted = /interrupted by another navigation/i.test(error.message);
      if (interrupted && attempt === 1) {
        await page.waitForTimeout(500);
        continue;
      }
      return { ok: false, error: error.message.split(/\r?\n/)[0] };
    }
  }

  return { ok: false, error: "navigation failed after retry" };
}
