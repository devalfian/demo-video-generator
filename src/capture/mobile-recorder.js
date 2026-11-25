import { runWalkthrough } from "../core/interaction-engine.js";
export async function recordMobile(page, demo, scenario, config) {
  return runWalkthrough(page, demo, scenario, config, "mobile");
}
