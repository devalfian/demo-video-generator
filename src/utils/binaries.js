import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_FALLBACKS = {
  ffmpeg: [
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
  ],
  ffprobe: [
    "C:\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe"
  ]
};

export const INSTALL_HINT =
  "Install FFmpeg (winget install Gyan.FFmpeg, or scoop/choco), add its bin directory to PATH, " +
  "or set FFMPEG_PATH / FFPROBE_PATH in .env to an absolute executable path.";

function envKey(name) {
  return `${name.toUpperCase()}_PATH`;
}

function projectFallbacks(name) {
  const local = path.join(process.cwd(), "bin");
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return [path.join(local, exe), ...(WINDOWS_FALLBACKS[name] || []), ...wingetCandidates(name, exe)];
}

/**
 * winget installs into %LOCALAPPDATA%\Microsoft\WinGet\Packages and exposes
 * shims in ...\WinGet\Links. Neither is on PATH until the shell is restarted.
 */
function wingetCandidates(name, exe) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];

  const found = [path.join(localAppData, "Microsoft", "WinGet", "Links", exe)];
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");

  try {
    for (const dir of fs.readdirSync(packagesDir)) {
      // Match the FFmpeg package, not the binary name (ffprobe lives in the same package).
      if (!dir.toLowerCase().includes("ffmpeg")) continue;
      const packageDir = path.join(packagesDir, dir);
      for (const sub of fs.readdirSync(packageDir)) {
        found.push(path.join(packageDir, sub, "bin", exe));
      }
    }
  } catch {
    return found;
  }

  return found;
}


/**
 * Resolve an executable: explicit env var, then a local ./bin copy, then common
 * Windows install locations, and finally the bare name (relying on PATH).
 */
export function resolveBinary(name) {
  const configured = (process.env[envKey(name)] || "").trim();
  if (configured && configured !== name) return configured;
  for (const candidate of projectFallbacks(name)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return configured || name;
}

export function runBinary(name, args, { timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const executable = resolveBinary(name);
    const child = spawn(executable, args, { windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

    child.on("error", error => {
      cleanup();
      if (error.code === "ENOENT") {
        reject(new Error(`${name} not found (tried "${executable}"). ${INSTALL_HINT}`));
        return;
      }
      reject(error);
    });

    child.on("close", code => {
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${name} exited ${code}: ${stderr.slice(-2000).trim()}`));
    });
  });
}

export async function assertBinary(name) {
  const executable = resolveBinary(name);
  try {
    const { stdout, stderr } = await runBinary(name, ["-version"], { timeoutMs: 15000 });
    return { name, executable, version: `${stdout}${stderr}`.split(/\r?\n/)[0].trim() };
  } catch (error) {
    throw new Error(`Required binary "${name}" is unavailable: ${error.message}`);
  }
}

export async function checkBinaries() {
  return Promise.all([assertBinary("ffmpeg"), assertBinary("ffprobe")]);
}

export async function probeMedia(file) {
  if (!fs.existsSync(file)) throw new Error(`Cannot probe missing file: ${file}`);
  const { stdout } = await runBinary("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name,r_frame_rate,duration",
    "-show_entries", "format=duration,size",
    "-of", "json",
    file
  ], { timeoutMs: 30000 });

  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  const format = parsed.format || {};
  const duration = Number(stream.duration ?? format.duration);

  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    codec: stream.codec_name || "",
    fps: parseFrameRate(stream.r_frame_rate),
    duration: Number.isFinite(duration) ? duration : 0,
    size: Number(format.size) || 0
  };
}

function parseFrameRate(value) {
  if (!value || typeof value !== "string") return 0;
  const [num, den] = value.split("/").map(Number);
  if (!den) return num || 0;
  return Math.round((num / den) * 1000) / 1000;
}
