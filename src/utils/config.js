import fs from "node:fs";
import path from "node:path";

export function loadJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
}
