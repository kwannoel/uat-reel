import type { Cue } from "./captions.js";
import type { Reproduction } from "./reproduce.js";

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
  scenes: {
    id: string;
    title: string;
    covers: string[];
    actor?: string;
    /** Ran to move the app along; not in the video. */
    offCamera?: boolean;
    start: number;
    end: number;
  }[];
  chapters: { title: string; start: number; end: number }[];
  cues: Cue[];
  boxes: { t: number; end: number; scene: string; step: number; label?: string; note?: string; target: string; rect: Rect }[];
  expects: { t: number; scene: string; step: number; target: string; text?: string; hidden?: boolean; ok: boolean }[];
  shots: { t: number; scene: string; step: number; kind: "box" | "expect" | "failure"; path: string }[];
  /** Waits on the app removed from the video: the cut is at `t`; `ms` of real time is missing there. */
  cuts: { t: number; ms: number; scene: string; step: number }[];
  /** Recorded segments in film order; joined into `outputs.raw`. */
  segments: { file: string; start: number; end: number; scene: string }[];
  outputs: Record<string, string>;
  /** Services this run started; each one's output is in `log`. */
  services?: { name: string; ready: string; log: string }[];
  /** How to reshoot this take; see `reproduce.sh`. */
  reproduce?: Reproduction;
}

/** One scene's recording, kept under `scenes/<id>.json` so `record --from` can reuse it. Times are scene-local. */
export interface SceneTake {
  id: string;
  title: string;
  covers: string[];
  actor?: string;
  offCamera: boolean;
  durationMs: number;
  segments: { file: string; start: number; end: number }[];
  chapters: Manifest["chapters"];
  cues: Manifest["cues"];
  boxes: Manifest["boxes"];
  expects: Manifest["expects"];
  cuts: Manifest["cuts"];
}
