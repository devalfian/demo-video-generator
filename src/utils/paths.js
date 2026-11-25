import path from "node:path";
import fs from "node:fs";

export const ROOT = process.cwd();
export const OUTPUT = path.join(ROOT, "output");
export const RAW = path.join(OUTPUT, "raw");
export const FINAL = path.join(OUTPUT, "final");
export const THUMBNAILS = path.join(OUTPUT, "thumbnails");
export const REPORTS = path.join(OUTPUT, "reports");

export function ensureOutputDirs() {
  for (const dir of [RAW, FINAL, THUMBNAILS, REPORTS]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function slugify(value) {
  return String(value).toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function demoKey(demo) {
  return `${demo.id}-${slugify(demo.business_name)}`;
}
