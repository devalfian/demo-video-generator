import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBinary, probeMedia } from "../utils/binaries.js";

export function runFfmpeg(args, options) {
  return runBinary("ffmpeg", args, options);
}

const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf"
];

function resolveFont(composition) {
  const configured = composition.fontFile;
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(`Configured fontFile does not exist: ${configured}`);
    return configured;
  }
  return FONT_CANDIDATES.find(candidate => fs.existsSync(candidate)) || null;
}

/**
 * FFmpeg splits option values on ":" and quoting does not protect a Windows
 * drive letter. Rather than escaping, every filter-referenced file is kept
 * relative and FFmpeg runs with cwd set to the temp directory.
 */
function prepareFont(fontFile, textDir) {
  fs.copyFileSync(fontFile, path.join(textDir, "font.ttf"));
  return "font.ttf";
}

/**
 * Fit inside a box with even dimensions. Computing this in JS keeps `scale`
 * deterministic; force_original_aspect_ratio plus rounding can emit odd sizes
 * that break the following `pad` step.
 */
export function fitInside(srcW, srcH, maxW, maxH) {
  const ratio = Math.min(maxW / srcW, maxH / srcH);
  const even = value => Math.max(2, Math.round(value) - (Math.round(value) % 2));
  return { w: even(srcW * ratio), h: even(srcH * ratio) };
}

/**
 * Mobile panel geometry derived from the real recording aspect ratio so the
 * recording never letterboxes inside its own device frame.
 */
export function computeLayout({ canvas, composition, mobileAspect }) {
  const pad = composition.outerPadding;
  const usableH = canvas.height - composition.headerHeight - composition.footerHeight - pad * 2;
  const even = value => Math.max(2, Math.round(value) - (Math.round(value) % 2));

  let mobileH = even(usableH);
  let mobileW = even(usableH * mobileAspect);
  if (mobileW > composition.mobilePanelWidth) {
    mobileW = even(composition.mobilePanelWidth);
    mobileH = even(mobileW / mobileAspect);
  }

  const preferredX = pad + composition.desktopWidth + composition.panelGap;
  const maxX = canvas.width - pad - mobileW;

  return {
    pad,
    usableH,
    desktopX: pad,
    desktopY: composition.headerHeight,
    desktopW: composition.desktopWidth,
    desktopH: usableH,
    mobileW,
    mobileH,
    mobileX: Math.max(pad, Math.min(preferredX, maxX)),
    mobileY: Math.round((canvas.height - mobileH) / 2)
  };
}

export async function composeVideo({ desktopPath, mobilePath, outputPath, thumbnailPath, demo, config }) {
  // FFmpeg runs with cwd = temp text dir, so every media path must be absolute.
  desktopPath = path.resolve(desktopPath);
  mobilePath = path.resolve(mobilePath);
  outputPath = path.resolve(outputPath);
  thumbnailPath = path.resolve(thumbnailPath);

  if (!fs.existsSync(desktopPath) || !fs.existsSync(mobilePath)) {
    throw new Error("Missing raw desktop/mobile recording");
  }

  const [desktopProbe, mobileProbe] = await Promise.all([probeMedia(desktopPath), probeMedia(mobilePath)]);
  if (!desktopProbe.width || !desktopProbe.height) throw new Error(`Unreadable desktop recording: ${desktopPath}`);
  if (!mobileProbe.width || !mobileProbe.height) throw new Error(`Unreadable mobile recording: ${mobilePath}`);

  const c = config.composition;
  const duration = config.durationSeconds;
  const { width: canvasW, height: canvasH } = config.canvas;
  const background = c.backgroundColor || "0x111827";
  const layout = computeLayout({
    canvas: config.canvas,
    composition: c,
    mobileAspect: mobileProbe.width / mobileProbe.height
  });

  const textDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-video-text-"));
  try {
    const font = resolveFont(c);
    if (!font) throw new Error("No usable font found for overlay text; set composition.fontFile in config/video.json");
    const fontName = prepareFont(font, textDir);

    const desktopFit = fitInside(desktopProbe.width, desktopProbe.height, layout.desktopW, layout.desktopH);
    const mobileFit = fitInside(mobileProbe.width, mobileProbe.height, layout.mobileW, layout.mobileH);

    const chain = [
      `[0:v]fps=${config.fps},scale=${desktopFit.w}:${desktopFit.h}:flags=lanczos,` +
        `pad=${layout.desktopW}:${layout.desktopH}:(ow-iw)/2:(oh-ih)/2:color=${background},setsar=1,format=yuv420p[d]`,
      `[1:v]fps=${config.fps},scale=${mobileFit.w}:${mobileFit.h}:flags=lanczos,` +
        `pad=${layout.mobileW}:${layout.mobileH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[m]`,
      `[d]pad=${canvasW}:${canvasH}:${layout.desktopX}:${layout.desktopY}:color=${background}[bg]`
    ];

    const frame = c.deviceFrame
      ? `drawbox=x=${layout.mobileX}:y=${layout.mobileY}:w=${layout.mobileW}:h=${layout.mobileH}:` +
        `color=${c.deviceFrameColor || "0x374151"}:t=${c.deviceFrameThickness || 3}`
      : "";

    const textFilters = buildTextFilters({ demo, config, layout, canvasH, textDir, fontName });
    const normalize = `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS`;
    const overlay = `[bg][m]overlay=${layout.mobileX}:${layout.mobileY}`;
    // Soften the first and last frames so the loop does not begin or end on a
    // hard edge (the capture itself already dissolves between pages).
    const fades = [
      `fade=t=in:st=0:d=${config.transitions?.videoFadeInSeconds ?? 0.4}:color=${background}`,
      `fade=t=out:st=${Math.max(0, duration - (config.transitions?.videoFadeOutSeconds ?? 0.6))}` +
        `:d=${config.transitions?.videoFadeOutSeconds ?? 0.6}:color=${background}`
    ];
    chain.push([overlay, normalize, frame, ...textFilters, ...fades, "format=yuv420p[v]"].filter(Boolean).join(","));

    await runFfmpeg([
      "-y", "-i", desktopPath, "-i", mobilePath,
      "-filter_complex", chain.join(";"),
      "-map", "[v]", "-an", "-t", String(duration),
      "-r", String(config.fps), "-c:v", config.encoding.videoCodec,
      "-preset", config.encoding.preset, "-crf", String(config.encoding.crf),
      "-pix_fmt", config.encoding.pixelFormat,
      "-movflags", "+faststart", outputPath
    ], { cwd: textDir });
  } finally {
    fs.rmSync(textDir, { recursive: true, force: true });
  }

  const thumbnailAt = config.thumbnailAtSeconds ?? 8;
  await runFfmpeg([
    "-y", "-ss", `00:00:${String(thumbnailAt).padStart(2, "0")}`,
    "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbnailPath
  ]);
}

function buildTextFilters({ demo, config, layout, canvasH, textDir, fontName }) {
  const { pad } = layout;
  const headerY = Math.max(16, config.composition.headerHeight - 30);
  const footerY = canvasH - config.composition.footerHeight + 18;
  const labels = config.composition.labels || {};

  const entries = [
    { name: "title", text: demo.business_name, color: "white", size: 34, x: pad, y: 34 },
    { name: "desktop-label", text: labels.desktop || "DESKTOP EXPERIENCE", color: "0xCBD5E1", size: 18, x: pad, y: headerY },
    { name: "mobile-label", text: labels.mobile || "MOBILE EXPERIENCE", color: "0xCBD5E1", size: 18, x: layout.mobileX, y: headerY },
    { name: "footer-label", text: labels.footer || "Website overview", color: "0x9CA3AF", size: 18, x: pad, y: footerY }
  ];

  return entries.map(entry => {
    fs.writeFileSync(path.join(textDir, `${entry.name}.txt`), String(entry.text ?? ""), "utf8");
    return `drawtext=fontfile=${fontName}:textfile=${entry.name}.txt` +
      `:fontcolor=${entry.color}:fontsize=${entry.size}:x=${entry.x}:y=${entry.y}`;
  });
}
