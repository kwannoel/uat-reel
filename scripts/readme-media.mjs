#!/usr/bin/env node
// Records the example storyboards and cuts the README media into docs/media/:
// <name>.mp4, the whole film, and <name>.webp, one scene as a looping preview.
// Usage: npm run build && npm run readme-media
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const media = join(root, "docs", "media");

const films = [
  { name: "checkout", storyboard: "examples/demo.storyboard.yaml", preview: "missing-details" },
  { name: "refund", storyboard: "examples/market.storyboard.yaml", preview: "refund" },
];

function ffmpeg(args) {
  return new Promise((done, fail) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
  });
}

// The example app's own demo password; the market storyboard starts the app itself.
process.env.MARKET_PASSWORD = "demo-password";
await mkdir(media, { recursive: true });
for (const film of films) {
  const out = join(root, "out", "readme-media", film.name);
  const { manifest } = await run({
    storyboard: join(root, film.storyboard),
    out,
    mode: "record",
    log: (line) => console.error(`${film.name}: ${line}`),
  });
  if (!manifest.ok || !manifest.outputs.video) throw new Error(`${film.name}: recording failed: ${manifest.error?.message ?? "no video"}`);
  const video = join(out, manifest.outputs.video);
  const scene = manifest.scenes.find((s) => s.id === film.preview);
  if (!scene) throw new Error(`${film.name}: no scene ${film.preview}`);

  const mp4 = join(media, `${film.name}.mp4`);
  const webp = join(media, `${film.name}.webp`);
  await ffmpeg(["-i", video, "-vf", "scale=960:-2", "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  await ffmpeg([
    "-ss", (scene.start / 1000).toFixed(2),
    "-t", ((scene.end - scene.start) / 1000).toFixed(2),
    "-i", video,
    "-vf", "fps=10,scale=720:-2:flags=lanczos",
    "-c:v", "libwebp_anim", "-loop", "0", "-quality", "60", "-compression_level", "6", "-an", webp,
  ]);
  const kb = async (f) => `${Math.round((await stat(f)).size / 1024)} KB`;
  console.log(`${film.name}: ${(manifest.durationMs / 1000).toFixed(1)}s film ${await kb(mp4)}, ${film.preview} preview ${await kb(webp)}`);
  console.log(`  reshoot: bash ${join("out", "readme-media", film.name, "reproduce.sh")}`);
}
await readFile(join(media, "checkout.webp")); // fail loudly if nothing was written
