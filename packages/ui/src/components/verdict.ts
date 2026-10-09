import type { Verdict } from "@cueprint/core";

/** [css class, label] for each verdict. */
export const VERDICT: Record<Verdict, readonly [string, string]> = {
  "hand moving": ["proven", "HAND MOVING"],
  "hands still": ["still", "HANDS STILL"],
  "no camera": ["nocam", "NO CAMERA"],
  "not proven": ["unproven", "NOT PROVEN"],
  "structure": ["struct", "STRUCTURE"],
  "pending": ["pending", "CHECKING CAMERA"],
};
