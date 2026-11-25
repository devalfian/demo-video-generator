import fs from "node:fs";
import path from "node:path";
import { REPORTS, ensureOutputDirs } from "../utils/paths.js";

export function saveReport(report) {
  ensureOutputDirs();
  const file = path.join(REPORTS, "generation-report.json");
  let existing = [];
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  const byId = new Map(existing.map(item => [item.id, item]));
  byId.set(report.id, report);
  fs.writeFileSync(file, JSON.stringify([...byId.values()], null, 2));
}
