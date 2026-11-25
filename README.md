# Automated Demo Video Generator v1.1

Generate one neutral-branded, 60-second combined desktop/mobile walkthrough video per business.

## Locked configuration

- Environment: Windows 10/11
- Capture: Playwright + Chromium
- Desktop viewport: 1440x900
- Mobile viewport: 390x844 (mobile emulation)
- Final video: 1920x1080, 30 FPS, H.264 MP4
- Duration target: 60 seconds
- Audio: none
- Branding: neutral (business name only; no agency branding)
- Composition: desktop panel + mobile device panel

## Requirements

1. Node.js 20 LTS or newer
2. FFmpeg **and ffprobe** installed and available on PATH
3. Windows PowerShell or Windows Terminal

Check:

```powershell
node --version
npm --version
ffmpeg -version
ffprobe -version
```

Install:

```powershell
npm install
npm run install:browsers
Copy-Item .env.example .env
```

Verify everything the generator needs:

```powershell
npm run doctor
```

`doctor` resolves FFmpeg/ffprobe and reports the exact executable it will use, plus the Chromium build. `generate` runs the same preflight before touching a browser, so a missing binary fails in seconds instead of after a full capture.

## Add demo URLs

Edit `data/demos.csv`:

```csv
id,business_name,base_url
001,All Australian Plumbing,https://plumber.digitalleads.my.id/all-australian-plumbing-and-maintenance-eastlakes-sydney
```

Use the business root URL, without a trailing page path such as `/services`.

## Run

Validate all URLs:

```powershell
npm run validate
```

List loaded demos:

```powershell
npm run list
```

Generate all demos:

```powershell
npm run generate
```

Generate only one:

```powershell
npm run generate -- --id 001
```

Test first five:

```powershell
npm run generate -- --limit 5
```

Resume failed or incomplete jobs:

```powershell
npm run generate -- --resume
```

Override concurrency:

```powershell
npm run generate -- --concurrency 1
```

## Output

```text
output/
  raw/
    001-all-australian-plumbing/
      desktop.webm
      mobile.webm
  final/
    001-all-australian-plumbing.mp4
  thumbnails/
    001-all-australian-plumbing.jpg
  reports/
    generation-report.json
    run.log
```

Raw recordings are always saved as `desktop.webm` and `mobile.webm`, regardless of the temporary `page@<hash>.webm` names Playwright uses internally.

## Walkthrough behavior

The scenario is configured in `config/scenario.json`. The engine:
- opens the business homepage and holds the opening view for `openingSeconds`
- dismisses cookie/consent banners by exact button label before recording the page
- moves through the page with smooth scrolling
- holds the last frame for `closingSeconds` before the recording ends
- records desktop and mobile simultaneously

### Which pages may be recorded

`allowedPaths` is an explicit allowlist. Only these pages are ever recorded — the homepage plus `/services`, `/service-areas`, `/about`, `/faq`, `/contact` and `/request-a-quote`:

- A route outside the allowlist is skipped (`skip:<path> not-allowed`), even if it is added to `routes`.
- Each route may declare `aliases` (e.g. `/service-area` for `/service-areas`). Aliases are tried in order and only when they are also in the allowlist.
- A page is skipped instead of recorded when it is an HTTP error, an error page rendered with a 200 (`404`, "not found", "something went wrong"), still blank/unfinished, or permanently `aria-busy`. Rendered text is polled until it stops growing, then checked against `minRenderedChars`.
- Skipped routes are recorded in the report with the reason, so a missing page is visible without watching the video.

### Smoothness

Real-time screen capture of a heavy page is the main source of judder, so several
things are controlled explicitly:

- **Frame rate matches the recorder.** Playwright captures at 25 fps, so the
  composer renders at 25 fps (`fps` in `config/video.json`). Forcing 30 fps only
  duplicated frames and made every movement stutter.
- **Scroll speed is constant, not eased by wall clock.** The page advances a fixed
  number of pixels per rendered frame, and `maxPxPerFrame` caps that step. On a
  slow page the scroll simply takes longer instead of lurching.
- **`scroll-behavior: smooth` from the site is overridden.** Without that, every
  `scrollTo` starts a new native animation that the next call cancels, which reads
  as uneven jumping.
- **Heavy paint effects are neutralised** (`will-change`, `filter`,
  `backdrop-filter`) because they drop the page below the video frame rate while
  scrolling. Disable with `capture.reducePaintCost: false`.
- **Scene changes are dissolves.** A transition layer is installed in every
  document; the outgoing page fades to the canvas colour and the incoming page
  fades in (`transitions.sceneFadeMs`). The first and last frames also fade.
- **Navigation waits for `commit`**, then polls rendered content until it stops
  growing, so a slow parse cannot blow the route's time budget.


The walkthrough is paced to be watched, not skimmed. Every page gets three beats:

1. `holdTopMs` — the page sits still at the top so the hero is read.
2. One continuous scroll that covers the whole page, paced by `scrollSpeedPxPerSecond` and capped by `maxPxPerFrame`.
3. `holdBottomMs` — the last screen is held instead of being cut away.

`route.seconds` is the relative weight used to divide the remaining time between the pages still queued. The per-page budget is capped by what that page can consume, so a short page does not sit frozen — the unused time rolls over to the pages after it. `openingSeconds` is charged to the home route on top of its budget, and capture always stops at `durationSeconds - closingSeconds`, which leaves an outro on the final screen.

Useful knobs when a site is slow to navigate: raise `durationSeconds`, raise `minDwellMs` so every page is guaranteed a floor, or lower `scrollSpeedPxPerSecond` (with `maxPxPerFrame`) to trade coverage for a slower, calmer scroll.

Scroll pacing is data-driven rather than fixed: `scrollSpeedPxPerSecond` sets how fast the page is panned, and `maxPxPerFrame` caps how far the page may jump per rendered frame. On a heavy page the frame rate drops, the cap takes over, and the scroll simply lasts longer — the motion stays even instead of becoming jumpy. `minScrollMs` / `maxScrollMs` bound that.

Because the cap wins on a heavy page, the effective speed is `min(scrollSpeedPxPerSecond, maxPxPerFrame × measured fps)`. Speeding the walkthrough up therefore means scaling **both** numbers, never `scrollSpeedPxPerSecond` alone:

| Knob | ×1 (calm) | ×2.5 (current default) |
| --- | --- | --- |
| `capture.scrollSpeedPxPerSecond` | 400 | 1000 |
| `capture.maxPxPerFrame` | 30 | 75 |
| `capture.minScrollMs` / `maxScrollMs` | 6000 / 30000 | 2400 / 12000 |
| `capture.holdTopMs` / `holdBottomMs` | 3000 / 2500 | 1200 / 2500 |
| `capture.minDwellMs` / `estimatedNavigationMs` | 9000 / 7000 | 3600 / 3500 |
| `durationSeconds` | 260 | 104 |
| `scenario.openingSeconds` / `closingSeconds` | 4 / 3 | 1.6 / 1.2 |

`durationSeconds` has to come down with the pacing, but do not compute it as `old / 2.5`. Capture stops at `durationSeconds - closingSeconds` and each route is capped by what it can consume (top hold + interactions + one scroll + bottom hold), so whatever is left over becomes a frozen last frame. Set it from the measured content end in `generation-report.json`: if the last `scroll-page` ends well before the timeline, the duration is too long.

The home route also runs a hover or a drawer demo before it scrolls, and that wall-clock time is charged to the same per-page budget (`interactionReserveMs` in `interaction-engine.js`). Without that reserve the home scroll was squeezed into whatever time was left and panned up to twice as fast as every other page — the one page that looked rushed.

### Mobile drawer

The drawer is a scene of its own: it is opened, held briefly, and closed and verified before scrolling. Scrolling aborts (`scroll-skipped: drawer-still-open`) rather than recording a page hidden behind the menu, and the `ensureClear` callback re-checks that the drawer is closed every `pollMs` while the scroll runs.

Website-specific selectors can be added to a demo row in a future extension; the generator uses resilient generic selectors.


## Important limitations / assumptions

- A generic crawler cannot reliably know every website's exact navigation structure. v1.0 uses common route names and best-effort menu/CTA detection.
- Some sites may block automation, load slowly, or have consent dialogs. Review the report and raw recordings for failed jobs.
- Mobile is Chromium device emulation, not a physical phone recording.
- The final 60-second duration is enforced by the composer. Capture is budgeted to `durationSeconds - closingSeconds`; any shortfall is frozen on the last frame and any overrun is trimmed.
- `ffprobe` validates every output (resolution, codec, frame rate, duration, size). A file that renders but is too short, the wrong size, or unreadable is reported as failed with the specific reason in `generation-report.json`.
- `reducedMotion` in `config/video.json` controls whether CSS animations run during capture. It defaults to `no-preference` so recorded pages look alive; set it to `reduce` if a site's animations make the recording unstable.
- The generator does not submit forms, make phone calls, or trigger real business transactions.
- Do not use this to record sites without permission. Respect robots, terms, and access controls.

## Troubleshooting

**FFmpeg or ffprobe not found**
Run `npm run doctor` to see which binary is missing and where it was looked for. Install FFmpeg (`winget install Gyan.FFmpeg`), add its `bin` directory to PATH and restart the terminal, or point `FFMPEG_PATH` / `FFPROBE_PATH` in `.env` at the executables. `.env` is loaded automatically at startup.

**Browser missing**
Run `npm run install:browsers`.

**Video is blank / site not ready**
Increase `navigationTimeoutMs`, `networkIdleTimeoutMs`, or `settleAfterNavigationMs` in `config/video.json`.

**Some routes return 404**
Edit `routes` in `config/scenario.json` to match the pages present on the demo site. Routes are skipped instead of failing the job, and each skip is recorded in the report.

**A demo fails**
The generator continues with the next demo and records the failure, including validation problems, in `output/reports/generation-report.json`.

