import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { readingMs, toSrt, toVtt, type Cue } from "./captions.js";
import { lint, formatFindings } from "./lint.js";
import { loadStoryboard } from "./load.js";
import type { Manifest, Rect } from "./manifest.js";
import { burnCaptions, durationMs, hasFfmpeg, softCaptions } from "./media.js";
import { installOverlay } from "./overlay-page.js";
import { buildReviewPack } from "./reviewpack.js";
import { actionOf, targetOf, type Scene, type Step, type Storyboard } from "./schema.js";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;

export interface RunOptions {
  storyboard: string;
  out: string;
  mode: "record" | "rehearse";
  baseUrl?: string;
  headed?: boolean;
  timeoutMs?: number;
  /** Skip ffmpeg post-processing (record mode). */
  post?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  manifest: Manifest;
  out: string;
}

const CHAPTER_MS = 2200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Actions where a viewer should see the pointer travel to the target. */
const POINTER = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);

/** Actions whose box goes up after the action, so it frames the result rather than the empty control. */
const BOX_AFTER = new Set(["expect", "waitFor", "fill", "select", "check", "uncheck"]);

declare global {
  interface Window {
    __uatReel: {
      highlight(el: Element, opts: object): Promise<Rect>;
      clear(): void;
      cursorTo(x: number, y: number, ms: number): Promise<void>;
      placeCursor(x: number, y: number): void;
      ripple(x: number, y: number, color: string): void;
      setChip(text: string | null): void;
      ready(): Promise<void>;
    };
  }
}

async function driverAssets(): Promise<{ js: string; css: string }> {
  const dist = dirname(require.resolve("driver.js"));
  const [js, css] = await Promise.all([
    readFile(join(dist, "driver.js.iife.js"), "utf8"),
    readFile(join(dist, "driver.css"), "utf8"),
  ]);
  return { js, css };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const file = resolve(opts.storyboard);
  const sb = await loadStoryboard(file);
  const findings = lint(sb);
  if (findings.some((f) => f.level === "error")) {
    throw new Error(`lint errors in ${opts.storyboard}\n${formatFindings(findings)}`);
  }

  const rehearse = opts.mode === "rehearse";
  const out = resolve(opts.out);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, rehearse ? "shots" : "."), { recursive: true });

  const pacing = rehearse
    ? { afterAction: 0, boxHold: 150, typeDelay: 0, cursorMs: 0, tail: 0 }
    : sb.pacing;
  const baseUrl = opts.baseUrl ?? sb.baseUrl;
  const resolveUrl = (u: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    if (baseUrl) return new URL(u, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href.replace(/([^:])\/\/+/g, "$1/");
    return pathToFileURL(resolve(dirname(file), u)).href;
  };

  const manifest: Manifest = {
    tool: "uat-reel",
    version: VERSION,
    storyboard: relative(out, file),
    title: sb.title,
    mode: opts.mode,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    viewport: sb.viewport,
    captionRules: { cps: sb.captions.cps, minMs: sb.captions.minMs },
    ok: true,
    scenes: [],
    chapters: [],
    cues: [],
    boxes: [],
    expects: [],
    shots: [],
    outputs: {},
  };

  const { js, css } = await driverAssets();
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: sb.viewport,
    deviceScaleFactor: 1,
    // The overlay injects inline styles; a strict Content-Security-Policy would otherwise strip them.
    bypassCSP: true,
    storageState: sb.storageState ? resolve(dirname(file), sb.storageState) : undefined,
  });
  context.setDefaultTimeout(opts.timeoutMs ?? 10_000);
  await context.addInitScript({ content: js });
  await context.addInitScript(installOverlay, { driverCss: css });
  const page = await context.newPage();

  let t0 = Date.now();
  const now = () => Date.now() - t0;
  let cursor = { x: sb.viewport.width / 2, y: sb.viewport.height / 2 };
  let chip: string | null = null;
  let openCue: Cue | null = null;
  let openBox: Manifest["boxes"][number] | null = null;
  let current = { scene: "", step: -1 };
  let shotSeq = 0;

  const shot = async (kind: "box" | "expect" | "failure") => {
    const name =
      kind === "failure"
        ? "failure.png"
        : `shots/${String(++shotSeq).padStart(3, "0")}-${current.scene}-s${current.step + 1}-${kind}.png`;
    await page.screenshot({ path: join(out, name) });
    manifest.shots.push({ t: now(), ...current, kind, path: name });
  };

  /** Re-applies chip and cursor after navigation wipes the DOM. */
  const sync = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(
          async ({ chip, x, y, showCursor }) => {
            await window.__uatReel.ready();
            window.__uatReel.setChip(chip);
            if (showCursor) window.__uatReel.placeCursor(x, y);
          },
          { chip, ...cursor, showCursor: sb.style.cursor && !rehearse },
        );
        return;
      } catch {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }
  };

  const flushCue = async () => {
    if (!openCue) return;
    const remaining = readingMs(openCue.text, sb.captions) - (now() - openCue.start);
    if (remaining > 0 && !rehearse) await sleep(remaining);
    openCue.end = now();
    manifest.cues.push(openCue);
    openCue = null;
  };

  const showBox = async (loc: Locator, step: Step, target: string) => {
    await loc.waitFor({ state: "visible" });
    await loc.scrollIntoViewIfNeeded();
    const label = typeof step.box === "string" ? step.box : undefined;
    const rect = await loc.evaluate(
      (el, o) => window.__uatReel.highlight(el, o),
      {
        label,
        note: step.note,
        color: sb.style.boxColor,
        width: sb.style.boxWidth,
        padding: sb.style.boxPadding,
        dim: sb.style.dim,
      },
    );
    const entry = { t: now(), end: 0, ...current, label, note: step.note, target, rect };
    manifest.boxes.push(entry);
    openBox = entry;
    if (rehearse) await shot("box");
  };

  /** A labelled box stays up long enough to read its label and note, and never less than boxHold. */
  const holdBox = async (step: Step) => {
    const text = [typeof step.box === "string" ? step.box : "", step.note ?? ""].join(" ").trim();
    const hold = rehearse || !text ? pacing.boxHold : Math.max(pacing.boxHold, readingMs(text, sb.captions));
    await sleep(hold);
  };

  const clearBox = async () => {
    await page.evaluate(() => window.__uatReel.clear()).catch(() => {});
    if (openBox) openBox.end = now();
    openBox = null;
  };

  const glide = async (loc: Locator, click: boolean) => {
    if (rehearse || !sb.style.cursor) return;
    const bb = await loc.boundingBox();
    if (!bb) return;
    cursor = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    await page.evaluate(({ x, y, ms }) => window.__uatReel.cursorTo(x, y, ms), { ...cursor, ms: pacing.cursorMs });
    if (click) {
      await page.evaluate(({ x, y, c }) => window.__uatReel.ripple(x, y, c), { ...cursor, c: sb.style.boxColor });
      await sleep(180);
    }
  };

  const expectText = async (loc: Locator, text: string) => {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let seen = "";
    while (Date.now() < deadline) {
      seen = (await loc.innerText().catch(() => "")) ?? "";
      if (seen.includes(text)) return;
      await sleep(100);
    }
    throw new Error(`expected ${loc} to contain ${JSON.stringify(text)}, saw ${JSON.stringify(seen.slice(0, 200))}`);
  };

  const runStep = async (step: Step, skipAction = false) => {
    const action = actionOf(step);
    if (step.say) {
      await flushCue();
      openCue = { start: now(), end: 0, text: step.say, scene: current.scene };
    }
    const target = targetOf(step);
    const loc = target ? page.locator(target) : undefined;
    const boxed = loc && target && (step.box !== undefined || action === "highlight");
    const after = action !== undefined && BOX_AFTER.has(action);

    if (boxed && !after) {
      await showBox(loc, step, target);
      await holdBox(step);
    }
    if (loc && action && POINTER.has(action)) {
      await loc.waitFor({ state: "visible" });
      await loc.scrollIntoViewIfNeeded();
      await glide(loc, action !== "hover");
    }
    if (boxed && !after) await clearBox();

    if (!skipAction) {
      switch (action) {
        case "goto":
          await page.goto(resolveUrl(step.goto!), { waitUntil: "load" });
          break;
        case "click":
          await loc!.click();
          break;
        case "fill":
          if (step.secret) {
            const masked = await loc!.evaluate((el) => el instanceof HTMLInputElement && el.type === "password");
            if (!masked) throw new Error(`secret fill target ${target} is not a password field; its value would be visible in the video`);
            await loc!.fill(step.value!);
          } else if (rehearse || pacing.typeDelay === 0) await loc!.fill(step.value!);
          else {
            await loc!.fill("");
            await loc!.pressSequentially(step.value!, { delay: pacing.typeDelay });
          }
          break;
        case "press":
          if (loc) await loc.press(step.press!);
          else await page.keyboard.press(step.press!);
          break;
        case "select":
          await loc!.selectOption(step.value!);
          break;
        case "check":
          await loc!.check();
          break;
        case "uncheck":
          await loc!.uncheck();
          break;
        case "hover":
          await loc!.hover();
          break;
        case "scroll":
          await loc!.scrollIntoViewIfNeeded();
          break;
        case "waitFor":
          await loc!.waitFor({ state: "visible" });
          break;
        case "wait":
          await sleep(rehearse ? 0 : step.wait!);
          break;
        case "expect": {
          const entry = { t: now(), ...current, target: target!, text: step.text, ok: false };
          manifest.expects.push(entry);
          await loc!.waitFor({ state: "visible" });
          if (step.text !== undefined) await expectText(loc!, step.text);
          entry.ok = true;
          entry.t = now();
          if (rehearse && !boxed) await shot("expect");
          break;
        }
        case "highlight":
        case undefined:
          break;
      }
    }

    if (boxed && after) {
      await showBox(loc, step, target);
      await holdBox(step);
      await clearBox();
    }
    if (action && action !== "wait" && action !== "highlight" && action !== "expect") {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sync();
      await sleep(pacing.afterAction);
    }
    if (step.pause && !rehearse) await sleep(step.pause);
  };

  const chapter = async (title: string, description: string) => {
    if (rehearse || !sb.style.chapters) return;
    const start = now();
    // Resolves once the card has been removed.
    await page.screencast.showChapter(title, { description: description || undefined, duration: CHAPTER_MS });
    manifest.chapters.push({ title, start, end: now() });
  };

  const runScene = async (scene: Scene, index: number, preRolled: boolean) => {
    current = { scene: scene.id, step: -1 };
    const entry = { id: scene.id, title: scene.title, covers: scene.covers, start: now(), end: 0 };
    manifest.scenes.push(entry);
    chip = sb.style.sceneChip ? `${index + 1}/${sb.scenes.length} · ${scene.title}` : null;
    await sync();
    log(`scene ${index + 1}/${sb.scenes.length} ${scene.id}`);
    const covers = sb.acceptance.filter((ac) => scene.covers.includes(ac.id));
    const heading = `${index + 1}. ${scene.title}`;
    const criteria = covers.map((ac) => `${ac.id}: ${ac.text}`).join(" · ");
    // The opening card carries the video title too, so the video doesn't start with two cards in a row.
    await chapter(heading, index === 0 ? [sb.title, criteria].filter(Boolean).join(" · ") : criteria);
    for (const [i, step] of scene.steps.entries()) {
      current = { scene: scene.id, step: i };
      await runStep(step, preRolled && i === 0);
    }
    await flushCue();
    entry.end = now();
  };

  const rawName = "raw.webm";
  let recording = false;
  let holdLastCue = false;
  try {
    // Load the first page before recording so the video opens on the app, not a blank tab.
    const first = sb.scenes[0]!.steps[0]!;
    const preRolled = actionOf(first) === "goto";
    if (preRolled) await page.goto(resolveUrl(first.goto!), { waitUntil: "load" });

    if (!rehearse) {
      await page.screencast.start({ path: join(out, rawName), size: sb.viewport, quality: 90, fps: 25 });
      recording = true;
    }
    t0 = Date.now();
    await sync();

    for (const [i, scene] of sb.scenes.entries()) {
      await runScene(scene, i, preRolled && i === 0);
    }
    await sleep(pacing.tail);
    holdLastCue = true;
  } catch (err) {
    manifest.ok = false;
    manifest.error = { ...current, message: (err as Error).message.split("\n")[0]! };
    log(`FAILED at ${current.scene} step ${current.step + 1}: ${manifest.error.message}`);
    await flushCue().catch(() => {});
    const scene = manifest.scenes.at(-1);
    if (scene && !scene.end) scene.end = now();
    await shot("failure").catch(() => {});
    await sleep(rehearse ? 0 : 1500);
  } finally {
    manifest.durationMs = now();
    if (recording) await page.screencast.stop().catch(() => {});
    await context.close();
    await browser.close();
  }

  if (!rehearse) {
    manifest.outputs.raw = rawName;
    // The screencast runs on past our clock while it stops, so stretch the closing caption to the
    // real end of the file rather than leaving an empty band.
    const lastCue = manifest.cues.at(-1);
    const fileMs = hasFfmpeg() ? durationMs(rawName, out) : undefined;
    if (holdLastCue && lastCue) lastCue.end = Math.max(lastCue.end, fileMs ?? manifest.durationMs);
    const srt = manifest.cues.length ? "captions.srt" : null;
    await writeFile(join(out, "captions.srt"), toSrt(manifest.cues, sb.captions.maxLineChars));
    await writeFile(join(out, "captions.vtt"), toVtt(manifest.cues, sb.captions.maxLineChars));
    manifest.outputs.srt = "captions.srt";
    manifest.outputs.vtt = "captions.vtt";
    if (opts.post !== false) {
      if (hasFfmpeg()) {
        log("post: burning captions");
        await burnCaptions(rawName, srt, "video.mp4", out, { height: sb.viewport.height, band: sb.captions.band });
        await softCaptions(rawName, srt, "video.clean.mp4", out);
        manifest.outputs.video = "video.mp4";
        manifest.outputs.clean = "video.clean.mp4";
      } else {
        log("post: ffmpeg not found; kept raw.webm and caption sidecars only");
      }
    }
  }
  await writeManifest(out, manifest);
  if (!rehearse && opts.post !== false && manifest.outputs.video) {
    log("post: building review pack");
    await buildReviewPack(out);
  }
  return { manifest, out };
}

export async function writeManifest(out: string, manifest: Manifest): Promise<void> {
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Default output folder: out/<name> for record, out/<name>-rehearse for rehearse. */
export function defaultOut(storyboard: string, mode: "record" | "rehearse"): string {
  const base = storyboard.split(/[\\/]/).pop()!.replace(/(\.storyboard)?\.ya?ml$/i, "");
  return join("out", mode === "record" ? base : `${base}-rehearse`);
}

export type { Storyboard };
