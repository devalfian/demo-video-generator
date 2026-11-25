
import path from "node:path";
import fs from "node:fs";

import { createCaptureSessions } from "./browser-manager.js";
import { recordDesktop } from "../capture/desktop-recorder.js";
import { recordMobile } from "../capture/mobile-recorder.js";
import { composeVideo } from "../composer/ffmpeg.js";
import { validateVideo } from "../validation/video-validator.js";
import { saveReport } from "../reporting/report-generator.js";

import {
  RAW,
  FINAL,
  THUMBNAILS,
  demoKey,
  ensureOutputDirs
} from "../utils/paths.js";

import { logger } from "../utils/logger.js";

export async function processDemo(demo, scenario, config) {
  ensureOutputDirs();

  const key = demoKey(demo);
  const rawDir = path.join(RAW, key);

  fs.mkdirSync(rawDir, { recursive: true });

  const finalPath = path.join(FINAL, `${key}.mp4`);
  const thumbPath = path.join(THUMBNAILS, `${key}.jpg`);

  const startedAt = new Date().toISOString();

  let sessions;
  let rawRecordings;

  try {
    logger.info(`Starting ${demo.id}: ${demo.business_name}`);

    sessions = await createCaptureSessions(
      demo,
      rawDir,
      config
    );

    const captureStart = Date.now();
    const [desktopEvents, mobileEvents] = await Promise.all([
      recordDesktop(sessions.desktopPage, demo, scenario, config),
      recordMobile(sessions.mobilePage, demo, scenario, config)
    ]);
    logger.info(`${demo.id} captured in ${((Date.now() - captureStart) / 1000).toFixed(1)}s`);

    const saveStart = Date.now();
    rawRecordings = await sessions.saveRecordings();
    logger.info(`${demo.id} recordings saved in ${((Date.now() - saveStart) / 1000).toFixed(1)}s`);
    sessions = null;

    const composeStart = Date.now();
    await composeVideo({
      desktopPath: rawRecordings.desktop,
      mobilePath: rawRecordings.mobile,
      outputPath: finalPath,
      thumbnailPath: thumbPath,
      demo,
      config
    });
    logger.info(`${demo.id} composed in ${((Date.now() - composeStart) / 1000).toFixed(1)}s`);

    const validation = await validateVideo(finalPath, config);

    const report = {
      id: demo.id,
      business_name: demo.business_name,
      base_url: demo.base_url,

      status: validation.ok ? "success" : "failed",

      output: finalPath,
      thumbnail: thumbPath,
      recordings: rawRecordings,

      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - Date.parse(startedAt)) / 100) / 10,

      desktop_events: desktopEvents,
      mobile_events: mobileEvents,

      validation,

      error: validation.ok ? null : validation.problems.join("; ")
    };

    saveReport(report);

    logger.info(
      `${demo.id} ${report.status}: ${finalPath}`
    );

    return report;

  } catch (error) {

    if (sessions) {
      await sessions.close().catch(() => {});
    }

    const report = {
      id: demo.id,
      business_name: demo.business_name,
      base_url: demo.base_url,

      status: "failed",

      started_at: startedAt,
      completed_at: new Date().toISOString(),

      error: error.message
    };

    saveReport(report);

    logger.error(
      `${demo.id} failed: ${error.message}`
    );

    return report;
  }
}
