import fs from "node:fs";
import path from "node:path";
import { REPORTS, ensureOutputDirs } from "./paths.js";

ensureOutputDirs();
const logPath = path.join(REPORTS, "run.log");

export const logger = {
  info(message) { write("INFO", message); },
  warn(message) { write("WARN", message); },
  error(message) { write("ERROR", message); }
};

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}
