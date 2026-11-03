import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { Camera } from "./camera.js";
import { readingMs, toSrt, toVtt, type Cue } from "./captions.js";
import { envRefs } from "./env.js";
import { lint, formatFindings } from "./lint.js";
import { parseStoryboard } from "./load.js";
import type { Manifest, Rect, SceneTake } from "./manifest.js";
import { burnCaptions, hasFfmpeg, joinSegments, softCaptions } from "./media.js";
import { installOverlay } from "./overlay-page.js";
import { buildReviewPack } from "./reviewpack.js";
import { runCommands, startServices, type RunningServices } from "./services.js";
import { ffmpegVersion, isSecretEnv, playwrightVersion, reproduceScript, toolCommit } from "./reproduce.js";
import { actionOf, targetOf, type Actor, type Scene, type Step, type Storyboard } from "./schema.js";
import { parse } from "yaml";
import { captured, interpolate } from "./vars.js";

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
  /** Record mode: replay scenes before this one unrecorded and reuse their saved takes. */
  from?: string;
  /** Run the storyboard's setup commands first (default true). */
  setup?: boolean;
  /** Where setup runs and relative paths resolve (default the storyboard's folder). */
  dir?: string;
  /** Start the storyboard's services (default true); false films an app already running. */
  services?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  manifest: Manifest;
  out: string;
}

const CHAPTER_MS = 2200;
/** The single session used when a storyboard declares no actors. */
const DEFAULT_ACTOR = "default";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Actions where a viewer should see the pointer travel to the target. */
const POINTER = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);

/** Actions whose box goes up after the action, so it frames the result rather than the empty control. */
const BOX_AFTER = new Set(["expect", "waitFor", "fill", "select", "check", "uncheck", "capture"]);

/** Actions that wait on the app; a wait longer than `pacing.cutAfter` is cut from the video. */
const CUTTABLE = new Set(["goto", "click", "press", "select", "check", "uncheck", "scroll", "waitFor", "expect", "capture"]);

const FAST = { afterAction: 0, boxHold: 150, typeDelay: 0, cursorMs: 0, tail: 0, cutAfter: 0 };

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

interface LiveActor {
  name: string;
  baseUrl?: string;
  context: BrowserContext;
  page: Page;
  cursor: { x: number; y: number };
}

function emptyTake(scene: Pick<Scene, "id" | "title" | "covers" | "actor" | "offCamera">): SceneTake {
  return {
    id: scene.id,
    title: scene.title,
    covers: scene.covers,
    actor: scene.actor,
    offCamera: Boolean(scene.offCamera),
    durationMs: 0,
    segments: [],
    chapters: [],
    cues: [],
    boxes: [],
    expects: [],
    cuts: [],
  };
}

/** Shifts every time in a take by `by` ms. */
function shiftTake(take: SceneTake, by: number): SceneTake {
  const t = <T extends { t: number }>(x: T) => ({ ...x, t: x.t + by });
  return {
    ...take,
    segments: take.segments.map((s) => ({ ...s, start: s.start + by, end: s.end + by })),
    chapters: take.chapters.map((c) => ({ ...c, start: c.start + by, end: c.end + by })),
    cues: take.cues.map((c) => ({ ...c, start: c.start + by, end: c.end + by })),
    boxes: take.boxes.map((b) => ({ ...t(b), end: b.end + by })),
    expects: take.expects.map(t),
    cuts: take.cuts.map(t),
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const file = resolve(opts.storyboard);
  // Read once: with --out on the folder that holds this storyboard (a rerun), the file is about to be removed.
  const source = await readFile(file, "utf8");
  const sb = parseStoryboard(source, opts.storyboard);
  const root = opts.dir ? resolve(opts.dir) : dirname(file);
  const findings = lint(sb);
  if (findings.some((f) => f.level === "error")) {
    throw new Error(`lint errors in ${opts.storyboard}\n${formatFindings(findings)}`);
  }

  const rehearse = opts.mode === "rehearse";
  const out = resolve(opts.out);
  const scenesDir = join(out, "scenes");
  const takePath = (id: string) => join(scenesDir, `${id}.json`);

  let fromIndex = 0;
  if (opts.from !== undefined) {
    if (rehearse) throw new Error("--from only applies to record");
    fromIndex = sb.scenes.findIndex((s) => s.id === opts.from);
    if (fromIndex < 0) throw new Error(`no scene ${opts.from}`);
    if (fromIndex > 0 && opts.setup !== false && sb.setup.length === 0) {
      throw new Error(
        "--from replays the earlier scenes to rebuild app state; add setup commands that reset it, or pass --no-setup to replay on the current state",
      );
    }
    for (const scene of sb.scenes.slice(0, fromIndex)) {
      if (!existsSync(takePath(scene.id))) throw new Error(`--from ${opts.from}: scene ${scene.id} has no saved take in ${scenesDir}; record it first`);
    }
  }
  if (fromIndex > 0) {
    // Keep the earlier scenes' takes and segments; everything else is rebuilt.
    const keep = new Set(sb.scenes.slice(0, fromIndex).map((s) => s.id));
    for (const entry of await readdir(out)) if (entry !== "scenes") await rm(join(out, entry), { recursive: true, force: true });
    for (const entry of await readdir(scenesDir)) {
      const id = /^(.+?)(?:-\d+\.webm|\.json)$/.exec(entry)?.[1];
      if (!id || !keep.has(id)) await rm(join(scenesDir, entry), { recursive: true, force: true });
    }
  } else {
    await rm(out, { recursive: true, force: true });
  }
  await mkdir(join(out, rehearse ? "shots" : "scenes"), { recursive: true });

  let services: RunningServices | undefined;
  try {
    if (opts.services !== false) services = await startServices(sb.services, { root, out, log });
    if (opts.setup !== false) await runCommands(sb.setup, root, log);
  } catch (err) {
    await services?.stop();
    throw err;
  }

  const actorSpecs: Record<string, Actor> = sb.actors ?? {
    [DEFAULT_ACTOR]: { baseUrl: sb.baseUrl, storageState: sb.storageState },
  };
  const resolveUrl = (u: string, base: string | undefined) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    if (base) return new URL(u, base.endsWith("/") ? base : `${base}/`).href.replace(/([^:])\/\/+/g, "$1/");
    return pathToFileURL(resolve(root, u)).href;
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
    cuts: [],
    segments: [],
    outputs: {},
    ...(services && sb.services.length
      ? { services: sb.services.map((sv) => ({ name: sv.name, ready: sv.ready, log: `services/${sv.name}.log` })) }
      : {}),
  };

  let sceneId = "";
  const camera = new Camera({
    record: !rehearse,
    size: sb.viewport,
    path: (seq) => {
      const rel = `scenes/${sceneId}-${String(seq).padStart(3, "0")}.webm`;
      return { abs: join(out, rel), rel };
    },
  });
  const now = () => camera.now();
  /** Off camera and in rehearse, nobody watches: skip reading holds and animation. */
  const quick = () => rehearse || !camera.isRolling;
  const pacing = () => (quick() ? FAST : sb.pacing);

  const { js, css } = await driverAssets();
  const browser = await chromium.launch({ headless: !opts.headed }).catch(async (err) => {
    await services?.stop();
    throw err;
  });
  const actors = new Map<string, LiveActor>();
  const vars: Record<string, string> = {};

  // The scene being run; rebound per scene and while an actor signs in.
  let actor!: LiveActor;
  let page!: Page;
  let take: SceneTake = emptyTake({ id: "", title: "", covers: [] });
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
          { chip, ...actor.cursor, showCursor: sb.style.cursor && !quick() },
        );
        return;
      } catch {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }
  };

  /** Runs work that waits on the app; while it takes longer than cutAfter the camera stops. */
  const settle = async <T>(work: Promise<T>): Promise<T> => {
    const after = pacing().cutAfter;
    if (!camera.isRolling || after === 0) return work;
    let done = false;
    const pause: { cut?: Promise<void>; t: number; wall: number; at: typeof current } = { t: 0, wall: 0, at: current };
    const timer = setTimeout(() => {
      if (done) return;
      Object.assign(pause, { t: now(), wall: Date.now(), at: { ...current }, cut: camera.cut() });
    }, after);
    try {
      return await work;
    } finally {
      done = true;
      clearTimeout(timer);
      if (pause.cut) {
        await pause.cut;
        take.cuts.push({ t: pause.t, ms: Date.now() - pause.wall, ...pause.at });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await camera.roll(page);
        await sync();
      }
    }
  };

  const flushCue = async () => {
    if (!openCue) return;
    const remaining = readingMs(openCue.text, sb.captions) - (now() - openCue.start);
    if (remaining > 0 && !quick()) await sleep(remaining);
    openCue.end = now();
    take.cues.push(openCue);
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
    if (camera.isRolling || rehearse) take.boxes.push(entry);
    openBox = entry;
    if (rehearse) await shot("box");
  };

  /** A labelled box stays up long enough to read its label and note, and never less than boxHold. */
  const holdBox = async (step: Step) => {
    const text = [typeof step.box === "string" ? step.box : "", step.note ?? ""].join(" ").trim();
    const hold = quick() || !text ? pacing().boxHold : Math.max(pacing().boxHold, readingMs(text, sb.captions));
    await sleep(hold);
  };

  const clearBox = async () => {
    await page.evaluate(() => window.__uatReel.clear()).catch(() => {});
    if (openBox) openBox.end = now();
    openBox = null;
  };

  const glide = async (loc: Locator, click: boolean) => {
    if (quick() || !sb.style.cursor) return;
    const bb = await loc.boundingBox();
    if (!bb) return;
    actor.cursor = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    await page.evaluate(({ x, y, ms }) => window.__uatReel.cursorTo(x, y, ms), { ...actor.cursor, ms: pacing().cursorMs });
    if (click) {
      await page.evaluate(({ x, y, c }) => window.__uatReel.ripple(x, y, c), { ...actor.cursor, c: sb.style.boxColor });
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

  const act = async (step: Step, loc: Locator | undefined, target: string | undefined, boxed: boolean) => {
    switch (actionOf(step)) {
      case "goto":
        await page.goto(resolveUrl(step.goto!, actor.baseUrl), { waitUntil: "load" });
        break;
      case "click":
        await loc!.click();
        break;
      case "fill":
        if (step.secret) {
          const masked = await loc!.evaluate((el) => el instanceof HTMLInputElement && el.type === "password");
          if (!masked) throw new Error(`secret fill target ${target} is not a password field; its value would be visible in the video`);
          await loc!.fill(step.value!);
        } else if (quick() || pacing().typeDelay === 0) await loc!.fill(step.value!);
        else {
          await loc!.fill("");
          await loc!.pressSequentially(step.value!, { delay: pacing().typeDelay });
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
        await loc!.waitFor({ state: step.hidden ? "hidden" : "visible" });
        break;
      case "wait":
        await sleep(quick() ? 0 : step.wait!);
        break;
      case "capture": {
        await loc!.waitFor({ state: "visible" });
        const text = await loc!.evaluate((el) =>
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
            ? el.value
            : (el as HTMLElement).innerText,
        );
        vars[step.as!] = captured(text, step.pattern);
        break;
      }
      case "expect": {
        const entry = { t: now(), ...current, target: target!, text: step.text, hidden: step.hidden, ok: false };
        take.expects.push(entry);
        await loc!.waitFor({ state: step.hidden ? "hidden" : "visible" });
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
  };

  const runStep = async (raw: Step, skipAction = false) => {
    const step = interpolate(raw, vars);
    const action = actionOf(step);
    const offCamera = Boolean(step.offCamera) && camera.isRolling;
    if (offCamera) await camera.cut();
    try {
      if (step.say && (rehearse || camera.isRolling)) {
        await flushCue();
        openCue = { start: now(), end: 0, text: step.say, scene: current.scene };
      }
      const target = targetOf(step);
      const loc = target ? page.locator(target) : undefined;
      const boxed = Boolean(loc && target && (step.box !== undefined || action === "highlight") && (rehearse || camera.isRolling));
      const after = action !== undefined && BOX_AFTER.has(action);

      if (boxed && !after) {
        await showBox(loc!, step, target!);
        await holdBox(step);
      }
      if (loc && action && POINTER.has(action)) {
        await loc.waitFor({ state: "visible" });
        await loc.scrollIntoViewIfNeeded();
        await glide(loc, action !== "hover");
      }
      if (boxed && !after) await clearBox();

      if (!skipAction) {
        const work = act(step, loc, target, boxed);
        await (action && CUTTABLE.has(action) ? settle(work) : work);
      }

      if (boxed && after) {
        await showBox(loc!, step, target!);
        await holdBox(step);
        await clearBox();
      }
      if (action && action !== "wait" && action !== "highlight" && action !== "expect" && action !== "capture") {
        await settle(page.waitForLoadState("domcontentloaded").catch(() => {}));
        await sync();
        await sleep(pacing().afterAction);
      }
      if (step.pause && !quick()) await sleep(step.pause);
    } finally {
      if (offCamera) {
        await camera.roll(page);
        await sync();
      }
    }
  };

  const chapter = async (title: string, description: string) => {
    if (!camera.isRolling || !sb.style.chapters) return;
    const start = now();
    // Resolves once the card has been removed.
    await page.screencast.showChapter(title, { description: description || undefined, duration: CHAPTER_MS });
    take.chapters.push({ title, start, end: now() });
  };

  const actorFor = async (name: string): Promise<LiveActor> => {
    const existing = actors.get(name);
    if (existing) return existing;
    const spec = actorSpecs[name]!;
    const context = await browser.newContext({
      viewport: sb.viewport,
      deviceScaleFactor: 1,
      // The overlay injects inline styles; a strict Content-Security-Policy would otherwise strip them.
      bypassCSP: true,
      storageState: spec.storageState ? resolve(root, spec.storageState) : undefined,
    });
    context.setDefaultTimeout(opts.timeoutMs ?? 10_000);
    await context.addInitScript({ content: js });
    await context.addInitScript(installOverlay, { driverCss: css });
    const created: LiveActor = {
      name,
      baseUrl: spec.baseUrl ?? opts.baseUrl ?? sb.baseUrl,
      context,
      page: await context.newPage(),
      cursor: { x: sb.viewport.width / 2, y: sb.viewport.height / 2 },
    };
    actors.set(name, created);
    if (spec.signIn?.length) {
      log(`sign in: ${name}`);
      const sceneTake = take;
      actor = created;
      page = created.page;
      take = emptyTake({ id: `sign-in-${name}`, title: "", covers: [] });
      for (const [i, step] of spec.signIn.entries()) {
        current = { scene: `sign-in-${name}`, step: i };
        await runStep(step);
      }
      take = sceneTake;
    }
    return created;
  };

  const onCameraIndexes = sb.scenes.flatMap((s, i) => (s.offCamera ? [] : [i]));
  const firstOnCamera = onCameraIndexes[0] ?? -1;
  const lastOnCamera = onCameraIndexes.at(-1) ?? -1;

  const runScene = async (scene: Scene, index: number) => {
    const replay = !rehearse && index < fromIndex;
    const onCamera = !rehearse && !replay && !scene.offCamera;
    sceneId = scene.id;
    take = emptyTake(scene);
    current = { scene: scene.id, step: -1 };
    actor = await actorFor(scene.actor ?? DEFAULT_ACTOR);
    page = actor.page;
    current = { scene: scene.id, step: -1 };
    chip = sb.style.sceneChip ? `${index + 1}/${sb.scenes.length} · ${scene.title}` : null;
    log(`${replay ? "replay" : scene.offCamera ? "off camera" : "scene"} ${index + 1}/${sb.scenes.length} ${scene.id}`);

    // Load a leading goto before rolling so the scene opens on the app, not a blank or stale page.
    const first = scene.steps[0]!;
    const preRolled = actionOf(first) === "goto" && !first.offCamera;
    if (preRolled) {
      await page.goto(resolveUrl(interpolate(first, vars).goto!, actor.baseUrl), { waitUntil: "load" });
      // Single-page apps keep rendering after load; a chapter card over a half-built page flickers.
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }

    const start = now();
    const segmentsBefore = camera.segments.length;
    if (onCamera) await camera.roll(page);
    await sync();
    const covers = sb.acceptance.filter((ac) => scene.covers.includes(ac.id));
    // Number the scenes a viewer sees; off-camera scenes would leave gaps.
    const heading = `${onCameraIndexes.indexOf(index) + 1}. ${scene.title}`;
    const criteria = covers.map((ac) => `${ac.id}: ${ac.text}`).join(" · ");
    // The opening card carries the video title too, so the video doesn't start with two cards in a row.
    const opening = index === firstOnCamera;
    await chapter(heading, opening ? [sb.title, criteria].filter(Boolean).join(" · ") : criteria);

    try {
      for (const [i, step] of scene.steps.entries()) {
        current = { scene: scene.id, step: i };
        await runStep(step, preRolled && i === 0);
      }
      await flushCue();
      if (onCamera && index === lastOnCamera) {
        await sleep(pacing().tail);
        // The closing caption holds through the tail rather than leaving an empty band.
        const last = take.cues.at(-1);
        if (last) last.end = now();
      }
    } finally {
      // Stop first: the film clock then stands still, so the scene ends exactly where its last segment does.
      if (onCamera) await camera.cut();
      take.durationMs = now() - start;
      take.segments = camera.segments.slice(segmentsBefore);
      if (!replay) {
        if (rehearse) {
          manifest.scenes.push({ id: scene.id, title: scene.title, covers: scene.covers, actor: scene.actor, offCamera: scene.offCamera, start, end: now() });
          manifest.chapters.push(...take.chapters);
          manifest.cues.push(...take.cues);
          manifest.boxes.push(...take.boxes);
          manifest.expects.push(...take.expects);
        } else {
          await writeFile(takePath(scene.id), `${JSON.stringify(shiftTake(take, -start), null, 2)}\n`);
        }
      }
    }
  };

  try {
    for (const [i, scene] of sb.scenes.entries()) await runScene(scene, i);
  } catch (err) {
    manifest.ok = false;
    manifest.error = { ...current, message: (err as Error).message.split("\n")[0]! };
    log(`FAILED at ${current.scene} step ${current.step + 1}: ${manifest.error.message}`);
    if (page) await shot("failure").catch(() => {});
  } finally {
    await camera.cut().catch(() => {});
    for (const a of actors.values()) await a.context.close().catch(() => {});
    await browser.close();
    await services?.stop();
  }

  if (rehearse) {
    manifest.durationMs = now();
  } else {
    await assemble(sb, manifest, takePath);
    const segments = manifest.segments.map((s) => ({ file: s.file, ms: s.end - s.start }));
    await writeFile(join(out, "captions.srt"), toSrt(manifest.cues, sb.captions.maxLineChars));
    await writeFile(join(out, "captions.vtt"), toVtt(manifest.cues, sb.captions.maxLineChars));
    manifest.outputs.srt = "captions.srt";
    manifest.outputs.vtt = "captions.vtt";
    if (opts.post !== false && segments.length) {
      if (hasFfmpeg()) {
        log("post: joining segments and burning captions");
        await joinSegments(segments, "raw.mp4", out);
        manifest.outputs.raw = "raw.mp4";
        const srt = manifest.cues.length ? "captions.srt" : null;
        await burnCaptions("raw.mp4", srt, "video.mp4", out, { height: sb.viewport.height, band: sb.captions.band });
        await softCaptions("raw.mp4", srt, "video.clean.mp4", out);
        manifest.outputs.video = "video.mp4";
        manifest.outputs.clean = "video.clean.mp4";
      } else {
        log("post: ffmpeg not found; kept the segments in scenes/ and caption sidecars only");
      }
    }
  }
  await writeReproduce(opts, manifest, { source, file, out, root });
  await writeManifest(out, manifest);
  if (!rehearse && opts.post !== false && manifest.outputs.video) {
    log("post: building review pack");
    await buildReviewPack(out);
  }
  return { manifest, out };
}

/** Writes `reproduce.sh` and the storyboard as run, so the take can be reshot from its folder alone. */
async function writeReproduce(
  opts: RunOptions,
  manifest: Manifest,
  at: { source: string; file: string; out: string; root: string },
): Promise<void> {
  const refs = envRefs(parse(at.source));
  const env = Object.fromEntries(refs.names.map((name) => [name, process.env[name]]));
  const secrets = refs.names.filter((name) => isSecretEnv(name, env[name], refs.secret));
  const args = [
    ...(opts.baseUrl ? ["--base-url", opts.baseUrl] : []),
    ...(opts.timeoutMs ? ["--timeout", String(opts.timeoutMs)] : []),
    ...(opts.mode === "record" && opts.post === false ? ["--no-post"] : []),
    ...(opts.setup === false ? ["--no-setup"] : []),
    ...(opts.services === false ? ["--no-services"] : []),
  ];
  manifest.reproduce = {
    script: "reproduce.sh",
    storyboard: "storyboard.yaml",
    source: relative(at.out, at.file),
    sha256: createHash("sha256").update(at.source).digest("hex"),
    uatReel: { version: VERSION, ...toolCommit() },
    playwright: playwrightVersion(),
    ffmpeg: opts.mode === "record" ? ffmpegVersion() : undefined,
    secrets,
  };
  await writeFile(join(at.out, "storyboard.yaml"), at.source);
  const script = reproduceScript({
    title: manifest.title,
    mode: opts.mode,
    startedAt: manifest.startedAt,
    out: at.out,
    dir: at.root,
    args,
    env,
    secrets,
    reproduction: manifest.reproduce,
  });
  await writeFile(join(at.out, "reproduce.sh"), script, { mode: 0o755 });
  manifest.outputs.reproduce = "reproduce.sh";
}

/** Lays the saved takes end to end, in storyboard order, as one film timeline. */
async function assemble(sb: Storyboard, manifest: Manifest, takePath: (id: string) => string): Promise<void> {
  let offset = 0;
  for (const scene of sb.scenes) {
    if (!existsSync(takePath(scene.id))) break;
    const take = shiftTake(JSON.parse(await readFile(takePath(scene.id), "utf8")) as SceneTake, offset);
    manifest.scenes.push({
      id: take.id,
      title: take.title,
      covers: take.covers,
      actor: take.actor,
      offCamera: take.offCamera || undefined,
      start: offset,
      end: offset + take.durationMs,
    });
    manifest.chapters.push(...take.chapters);
    manifest.cues.push(...take.cues);
    manifest.boxes.push(...take.boxes);
    manifest.expects.push(...take.expects);
    manifest.cuts.push(...take.cuts);
    manifest.segments.push(...take.segments.map((s) => ({ ...s, scene: take.id })));
    offset += take.durationMs;
  }
  manifest.durationMs = offset;
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
