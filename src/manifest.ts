import type { Cue } from "./captions.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything a reviewer needs to line up what should be on screen with what is. Times are ms from video start. */
export interface Manifest {
  tool: "uat-reel";
  version: string;
  storyboard: string;
  title: string;
  mode: "record" | "rehearse";
  startedAt: string;
  durationMs: number;
  viewport: { width: number; height: number };
  captionRules: { cps: number; minMs: number };
  ok: boolean;
  error?: { scene: string; step: number; message: string };
  scenes: { id: string; title: string; covers: string[]; start: number; end: number }[];
  chapters: { title: string; start: number; end: number }[];
  cues: Cue[];
  boxes: { t: number; end: number; scene: string; step: number; label?: string; note?: string; target: string; rect: Rect }[];
  expects: { t: number; scene: string; step: number; target: string; text?: string; ok: boolean }[];
  shots: { t: number; scene: string; step: number; kind: "box" | "expect" | "failure"; path: string }[];
  outputs: Record<string, string>;
}
