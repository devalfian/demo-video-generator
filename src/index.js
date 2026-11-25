import "./utils/env.js";

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadDemos } from "./data/demo-loader.js";
import { loadJson } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { processDemo } from "./core/job-runner.js";
import { validateUrls } from "./validation/url-validator.js";
import { checkBinaries, resolveBinary } from "./utils/binaries.js";
import { REPORTS } from "./utils/paths.js";

const program = new Command();
program.name("demo-video-generator").description("Automated desktop/mobile demo video generator").version("1.1.0");

program.command("list").description("List demo records").action(() => {
  for (const demo of loadDemos()) console.log(`${demo.id}\t${demo.business_name}\t${demo.base_url}`);
});

program.command("doctor").description("Check FFmpeg, ffprobe and Chromium availability").action(async () => {
  let ok = true;

  try {
    const binaries = await checkBinaries();
    for (const binary of binaries) logger.info(`${binary.name}: ${binary.executable} -> ${binary.version}`);
  } catch (error) {
    ok = false;
    logger.error(error.message);
  }

  const { chromium } = await import("playwright");
  const executable = chromium.executablePath();
  if (fs.existsSync(executable)) logger.info(`chromium: ${executable}`);
  else {
    ok = false;
    logger.error(`chromium missing at ${executable}. Run: npm run install:browsers`);
  }

  logger.info(`ffmpeg resolved to: ${resolveBinary("ffmpeg")}`);
  if (!ok) process.exitCode = 1;
});


program.command("validate").description("Validate demo URLs").action(async () => {
  const ok = await validateUrls();
  if (!ok) process.exitCode = 1;
});

program.command("generate")
  .option("--id <id>", "Generate a single demo by ID")
  .option("--limit <number>", "Limit number of demos", value => Number(value))
  .option("--concurrency <number>", "Parallel demo jobs", value => Number(value))
  .option("--resume", "Skip demos already completed successfully")
  .action(async options => {
    const config = loadJson("config/video.json");
    const scenario = loadJson("config/scenario.json");
    let demos = loadDemos();
    if (options.id) demos = demos.filter(d => d.id === options.id);
    if (options.limit) demos = demos.slice(0, options.limit);
    if (!demos.length) throw new Error("No matching demos found");

    try {
      const binaries = await checkBinaries();
      logger.info(`Preflight OK: ${binaries.map(binary => binary.name).join(", ")}`);
    } catch (error) {
      logger.error(`Preflight failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (options.resume) {
      const reportPath = path.join(REPORTS, "generation-report.json");
      if (fs.existsSync(reportPath)) {
        const reports = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        const completed = new Set(reports.filter(r => r.status === "success").map(r => r.id));
        demos = demos.filter(d => !completed.has(d.id));
      }
    }

    const concurrency = Math.max(1, Math.min(4, options.concurrency || config.concurrency || 2));
    logger.info(`Queue: ${demos.length} demos | concurrency: ${concurrency}`);
    let cursor = 0;
    const results = [];
    async function worker() {
      while (cursor < demos.length) {
        const current = demos[cursor++];
        let result;
        for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
          result = await processDemo(current, scenario, config);
          if (result.status === "success") break;
          if (attempt < config.retryAttempts) logger.warn(`Retry ${attempt + 1}/${config.retryAttempts} for ${current.id}`);
        }
        results.push(result);
        logger.info(`Progress: ${results.length}/${demos.length}`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    const succeeded = results.filter(r => r.status === "success").length;
    logger.info(`Finished: ${succeeded}/${results.length} successful`);
    if (succeeded !== results.length) process.exitCode = 1;
  });

program.parseAsync().catch(error => {
  logger.error(error.stack || error.message);
  process.exitCode = 1;
});
