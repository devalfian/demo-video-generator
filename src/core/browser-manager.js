import path from "node:path";
import fs from "node:fs";
import { chromium, devices } from "playwright";
import { installTransitionLayer, installPaintCostReducer } from "./page-loader.js";

export async function createCaptureSessions(demo, rawDir, videoConfig) {
  const capture = videoConfig.capture || {};
  const browser = await chromium.launch({ headless: capture.headless !== false });

  const shared = {
    reducedMotion: capture.reducedMotion ?? "reduce",
    colorScheme: capture.colorScheme ?? "light"
  };

  const desktopContext = await browser.newContext({
    ...shared,
    viewport: videoConfig.desktop,
    deviceScaleFactor: videoConfig.desktop.deviceScaleFactor || 1,
    recordVideo: { dir: rawDir, size: { width: videoConfig.desktop.width, height: videoConfig.desktop.height } }
  });

  const mobileContext = await browser.newContext({
    ...devices["iPhone 13"],
    ...shared,
    viewport: videoConfig.mobile,
    deviceScaleFactor: videoConfig.mobile.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: rawDir, size: { width: videoConfig.mobile.width, height: videoConfig.mobile.height } }
  });

  const desktopPage = await desktopContext.newPage();
  const mobilePage = await mobileContext.newPage();

  // Installed per page, before the first navigation, so the transition layer is
  // present in every document the recording ever shows.
  const transition = {
    color: `#${(videoConfig.composition?.backgroundColor || "0x111827").replace(/^0x/i, "")}`,
    fadeMs: videoConfig.transitions?.sceneFadeMs ?? 420
  };
  await Promise.all([
    installTransitionLayer(desktopPage, transition),
    installTransitionLayer(mobilePage, transition)
  ]);

  if (videoConfig.capture?.reducePaintCost !== false) {
    await Promise.all([installPaintCostReducer(desktopPage), installPaintCostReducer(mobilePage)]);
  }

  const desktopVideo = desktopPage.video();
  const mobileVideo = mobilePage.video();

  return {
    browser,
    desktopContext,
    mobileContext,
    desktopPage,
    mobilePage,

    async close() {
      await Promise.allSettled([desktopPage.close(), mobilePage.close()]);
      await Promise.allSettled([desktopContext.close(), mobileContext.close()]);
      await browser.close().catch(() => {});
    },

    /**
     * Playwright names raw recordings page@<hash>.webm. Save them under stable
     * names so the composer and the docs agree on what exists on disk.
     * The video is only flushed once the page is closed, so pages are closed
     * here before saving and the contexts follow afterwards.
     */
    async saveRecordings() {
      await Promise.allSettled([desktopPage.close(), mobilePage.close()]);

      const targets = {
        desktop: path.join(rawDir, "desktop.webm"),
        mobile: path.join(rawDir, "mobile.webm")
      };

      try {
        for (const [kind, video] of [["desktop", desktopVideo], ["mobile", mobileVideo]]) {
          if (!video) throw new Error(`Missing ${kind} recording handle`);
          // video.path() resolves once the recording is flushed; renaming avoids
          // the extra copy that saveAs performs on a multi-megabyte webm.
          const original = await video.path();
          if (path.resolve(original) === path.resolve(targets[kind])) continue;
          try {
            fs.renameSync(original, targets[kind]);
          } catch {
            await video.saveAs(targets[kind]);
            fs.rmSync(original, { force: true });
          }
        }
      } finally {
        await Promise.allSettled([desktopContext.close(), mobileContext.close()]);
        await browser.close().catch(() => {});
      }

      return targets;
    }
  };
}

