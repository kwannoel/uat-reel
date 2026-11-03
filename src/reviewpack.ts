import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readingMs } from "./captions.js";
import type { Manifest } from "./manifest.js";
import { contactSheets, durationMs, frameAt } from "./media.js";

const GAP_MS = 4000;
const BOX_SETTLE_MS = 400;
const CONTACT_EVERY_SEC = 2;

/**
 * Extracts stills from the finished video and writes REVIEW.md, which pairs every still with what
 * should be visible in it. An agent reviewer cannot watch video; this is what it reviews instead.
 */
export async function buildReviewPack(out: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as Manifest;
  const video = manifest.outputs.video ?? manifest.outputs.raw;
  if (!video) throw new Error(`${out}: no video in manifest outputs; run record first`);

  const dir = join(out, "review");
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "frames"), { recursive: true });

  const videoMs = durationMs(video, out) ?? manifest.durationMs;
  const clampT = (t: number) => Math.min(Math.max(0, t), Math.max(0, videoMs - 100));
  const pad = (n: number) => String(n).padStart(2, "0");
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  type Row = { file: string; t: number; scene: string; caption: string; box: string };
  const rows: Row[] = [];
  const captionAt = (t: number) => manifest.cues.find((c) => c.start <= t && t < c.end)?.text ?? "—";

  for (const [i, cue] of manifest.cues.entries()) {
    const t = clampT((cue.start + cue.end) / 2);
    const file = `frames/cue-${pad(i + 1)}.jpg`;
    await frameAt(video, t, join("review", file), out);
    const box = manifest.boxes.find((b) => b.t <= t && t <= (b.end || b.t + 1500));
    rows.push({ file, t, scene: cue.scene, caption: cue.text, box: box ? describeBox(box) : "none expected" });
  }
  for (const [i, ch] of manifest.chapters.entries()) {
    const t = clampT((ch.start + ch.end) / 2);
    const file = `frames/chapter-${pad(i + 1)}.jpg`;
    await frameAt(video, t, join("review", file), out);
    rows.push({ file, t, scene: "—", caption: `none (chapter card "${ch.title}" centred)`, box: "none expected" });
  }
  for (const [i, b] of manifest.boxes.entries()) {
    const t = clampT(b.t + BOX_SETTLE_MS);
    const file = `frames/box-${pad(i + 1)}.jpg`;
    await frameAt(video, t, join("review", file), out);
    rows.push({ file, t, scene: b.scene, caption: captionAt(t), box: describeBox(b) });
  }
  rows.sort((a, b) => a.t - b.t);
  await contactSheets(video, "review/contact-%02d.jpg", CONTACT_EVERY_SEC, out);

  const timing: string[] = [];
  for (const cue of manifest.cues) {
    const need = readingMs(cue.text, manifest.captionRules);
    if (cue.end - cue.start < need) {
      timing.push(`- Cue at ${sec(cue.start)} shows for ${sec(cue.end - cue.start)}, needs ~${sec(need)}: "${cue.text}"`);
    }
  }
  // Chapter cards explain themselves, so only time with neither a cue nor a card counts as silent.
  const spoken = [...manifest.cues, ...manifest.chapters].sort((a, b) => a.start - b.start);
  let last = 0;
  for (const span of spoken) {
    if (span.start - last > GAP_MS) timing.push(`- ${sec(span.start - last)} with no caption, ${sec(last)}–${sec(span.start)}`);
    last = Math.max(last, span.end);
  }
  if (videoMs - last > GAP_MS) timing.push(`- ${sec(videoMs - last)} with no caption at the end, ${sec(last)}–${sec(videoMs)}`);

  const md = [
    `# Review pack: ${manifest.title}`,
    "",
    `- Video: \`${video}\`, ${sec(videoMs)}, page viewport ${manifest.viewport.width}×${manifest.viewport.height}`,
    `- Recorded: ${manifest.startedAt} with uat-reel ${manifest.version}`,
    ...(manifest.reproduce
      ? [`- Reproduce: \`bash ${manifest.reproduce.script}\` reshoots the whole film${manifest.reproduce.secrets.length ? `; set ${manifest.reproduce.secrets.join(", ")} first` : ""}`]
      : []),
    `- Result: ${manifest.ok ? "all steps and expects passed" : `**FAILED** at scene \`${manifest.error?.scene}\` step ${(manifest.error?.step ?? 0) + 1}: ${manifest.error?.message}`}`,
    `- Contact sheets: \`review/contact-NN.jpg\`, one tile every ${CONTACT_EVERY_SEC}s, timestamp top-left`,
    "",
    "## Scenes",
    "",
    "| # | Scene | Covers | Start | Length |",
    "|---|---|---|---|---|",
    ...manifest.scenes.map(
      (s, i) =>
        `| ${i + 1} | ${s.title} (\`${s.id}\`)${s.actor ? `, as ${s.actor}` : ""} | ${s.covers.join(", ") || "—"} | ${s.offCamera ? "off camera" : sec(s.start)} | ${s.offCamera ? "—" : sec(s.end - s.start)} |`,
    ),
    "",
    "## Expected vs actual",
    "",
    "Open each frame and check that the caption burned in under the page and any red box match the expected columns. A red box listed as expected may already be fading if the step clicked it.",
    "",
    "| Frame | Time | Scene | Caption that should be visible | Red box that should be visible |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| \`review/${r.file}\` | ${sec(r.t)} | ${r.scene} | ${esc(r.caption)} | ${esc(r.box)} |`),
    "",
    "## Expects",
    "",
    ...(manifest.expects.length
      ? manifest.expects.map(
          (e) => `- ${e.ok ? "pass" : "**FAIL**"} ${sec(e.t)} \`${e.target}\`${e.hidden ? " gone" : e.text ? ` contains "${e.text}"` : " visible"} (${e.scene})`,
        )
      : ["- none"]),
    "",
    "## Timing",
    "",
    ...(timing.length ? timing : ["- No short cues, and no caption gaps over 4s."]),
    "",
    "## Jump cuts",
    "",
    "Waits on the app longer than `pacing.cutAfter` are cut. Check that each cut does not hide a state the viewer needs.",
    "",
    ...((manifest.cuts ?? []).length
      ? manifest.cuts.map((c) => `- ${sec(c.t)}: ${sec(c.ms)} of waiting removed (${c.scene} step ${c.step + 1})`)
      : ["- none"]),
    "",
  ].join("\n");
  await writeFile(join(dir, "REVIEW.md"), md);
  return dir;
}

function describeBox(b: Manifest["boxes"][number]): string {
  return `${b.label ? `"${b.label}" around ` : ""}\`${b.target}\``;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}
