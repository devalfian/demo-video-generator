import { runWalkthrough } from "../core/interaction-engine.js";
export async function recordDesktop(page, demo, scenario, config) {
  return runWalkthrough(page, demo, scenario, config, "desktop");
}
