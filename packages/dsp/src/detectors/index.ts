import type { Detector } from "@cueprint/core";
import { eqDetector } from "./eq.ts";
import { filterDetector } from "./filter.ts";
import { loopDetector } from "./loop.ts";
import { sectionDetector } from "./section.ts";

export { eqDetector, filterDetector, loopDetector, sectionDetector };

/** Built-in detectors, in run order. Copy and extend to register more. */
export const defaultDetectors: readonly Detector[] = [eqDetector, filterDetector, sectionDetector, loopDetector];
