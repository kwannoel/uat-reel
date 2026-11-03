import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }).status === 0;
}

export function ffmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${args.join(" ")} exited ${code}\n${stderr.trim()}`)),
    );
  });
}

export function durationMs(file: string, cwd: string): number | undefined {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { cwd, encoding: "utf8" },
  );
  const sec = Number.parseFloat(res.stdout);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : undefined;
}

const H264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

/**
 * libass scales FontSize and MarginV against a 288-line script canvas mapped onto the output height,
 * so pixel sizes are converted here. With `band`, the frame is padded with a black strip that holds the
 * captions, so they never cover the page.
 */
export function captionFilter(srt: string, opts: { height: number; band: boolean }): string {
  const bandPx = opts.band ? Math.round((opts.height * 0.17) / 2) * 2 : 0;
  const outH = opts.height + bandPx;
  const fontPx = Math.round(opts.height * 0.042);
  const lineH = fontPx * 1.3;
  const marginPx = opts.band ? Math.max(8, Math.round((bandPx - lineH) / 2)) : Math.round(opts.height * 0.04);
  const units = (px: number) => ((px * 288) / outH).toFixed(2);
  const style = [
    "FontName=Helvetica",
    `FontSize=${units(fontPx)}`,
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H59000000",
    opts.band ? "BorderStyle=1,Outline=0,Shadow=0" : "BorderStyle=3,Outline=1.6,Shadow=0",
    `MarginV=${units(marginPx)}`,
    "Alignment=2",
  ].join(",");
  const pad = opts.band ? `pad=iw:ih+${bandPx}:0:0:color=black,` : "";
  return `${pad}subtitles=${srt}:force_style='${style}'`;
}

/** All paths are relative to `cwd` so the subtitles filter never needs path escaping. */
export async function burnCaptions(
  raw: string,
  srt: string | null,
  out: string,
  cwd: string,
  opts: { height: number; band: boolean },
): Promise<void> {
  const vf = srt ? ["-vf", captionFilter(srt, opts)] : [];
  await ffmpeg(["-i", raw, ...vf, ...H264, "-an", out], cwd);
}

export async function softCaptions(raw: string, srt: string | null, out: string, cwd: string): Promise<void> {
  const subs = srt
    ? ["-i", srt, "-map", "0:v", "-map", "1:s", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng"]
    : [];
  await ffmpeg(["-i", raw, ...subs, ...H264, "-an", out], cwd);
}

export async function frameAt(video: string, ms: number, out: string, cwd: string): Promise<void> {
  await ffmpeg(["-ss", (Math.max(0, ms) / 1000).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "3", out], cwd);
}

/** 4×4 grids sampled every `everySec`, each tile stamped with its timestamp. */
export async function contactSheets(video: string, pattern: string, everySec: number, cwd: string): Promise<void> {
  const stamp = "drawtext=text='%{pts\\:hms}':x=10:y=10:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6";
  const tail = `fps=1/${everySec},scale=480:-2,tile=4x4:padding=6:margin=6:color=white`;
  try {
    await ffmpeg(["-i", video, "-vf", `${stamp},${tail}`, "-fps_mode", "vfr", "-q:v", "3", pattern], cwd);
  } catch {
    // drawtext needs a usable default font; fall back to unstamped sheets rather than none.
    await ffmpeg(["-i", video, "-vf", tail, "-fps_mode", "vfr", "-q:v", "3", pattern], cwd);
  }
}

/**
 * Joins recorded segments in order, each cut at its recorded length (Playwright pads every file with
 * about a second of its last frame), into one H.264 file. Paths are relative to `cwd`.
 */
export async function joinSegments(segments: { file: string; ms: number }[], out: string, cwd: string): Promise<void> {
  await writeFile(join(cwd, "segments.ffconcat"), joinList(segments));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "segments.ffconcat", ...H264, "-an", out], cwd);
}

export function joinList(segments: { file: string; ms: number }[]): string {
  const lines = ["ffconcat version 1.0"];
  for (const s of segments) {
    lines.push(`file '${s.file.replace(/'/g, "'\\''")}'`, `outpoint ${(Math.max(1, s.ms) / 1000).toFixed(3)}`);
  }
  return `${lines.join("\n")}\n`;
}
