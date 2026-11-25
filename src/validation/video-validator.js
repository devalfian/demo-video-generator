import fs from "node:fs";
import { probeMedia } from "../utils/binaries.js";

/**
 * Validate the rendered MP4 with ffprobe instead of trusting file size alone.
 * Returns { ok, problems, probe } so the report can explain what was wrong.
 */
export async function validateVideo(file, config = {}) {
  const problems = [];
  const rules = config.validation || {};
  const minBytes = rules.minBytes ?? 100_000;
  const tolerance = rules.durationToleranceSeconds ?? 1;
  const expectedDuration = config.durationSeconds;

  if (!fs.existsSync(file)) {
    return { ok: false, problems: ["Output file is missing"], probe: null };
  }

  const size = fs.statSync(file).size;
  if (size < minBytes) {
    problems.push(`File is only ${size} bytes (minimum ${minBytes})`);
  }

  let probe;
  try {
    probe = await probeMedia(file);
  } catch (error) {
    return { ok: false, problems: [...problems, `ffprobe failed: ${error.message}`], probe: null };
  }

  if (!probe.width || !probe.height) {
    problems.push("No decodable video stream");
  } else if (config.canvas && (probe.width !== config.canvas.width || probe.height !== config.canvas.height)) {
    problems.push(`Resolution ${probe.width}x${probe.height} does not match ${config.canvas.width}x${config.canvas.height}`);
  }

  if (expectedDuration && Math.abs(probe.duration - expectedDuration) > tolerance) {
    problems.push(`Duration ${probe.duration.toFixed(2)}s is outside ${expectedDuration}s +/- ${tolerance}s`);
  }

  const expectedCodec = config.encoding?.videoCodec;
  if (expectedCodec === "libx264" && probe.codec && probe.codec !== "h264") {
    problems.push(`Codec is ${probe.codec}, expected h264`);
  }

  if (config.fps && probe.fps && Math.abs(probe.fps - config.fps) > 0.5) {
    problems.push(`Frame rate ${probe.fps} does not match ${config.fps}`);
  }

  return { ok: problems.length === 0, problems, probe };
}

