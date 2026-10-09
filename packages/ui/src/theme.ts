import type { Move } from "@cueprint/core";

// Faceplate palette. Canvas needs literal colors; styles.css mirrors these as tokens.
export const theme = {
  plate: "#e6e3db",
  plate2: "#efede7",
  well: "#dcd8ce",
  line: "#c4c0b5",
  line2: "#a9a59a",
  ink: "#141414",
  soft: "#77736a",
  faint: "#a39f95",
  hot: "#ff4f00",
  hotWash: "rgba(255,79,0,.12)",
  mono: '"IBM Plex Mono", ui-monospace, monospace',
  wide: '"Archivo Variable", "Archivo", ui-sans-serif, system-ui, sans-serif',
};

/** Tracks alternate ink / soft so deck A and deck B read apart without a rainbow. */
export const trackColor = (i: number) => (i % 2 === 0 ? theme.ink : theme.soft);

export function verdictColor(m: Move): string {
  if (m.verdict === "hand moving") return theme.hot;
  return theme.ink;
}
