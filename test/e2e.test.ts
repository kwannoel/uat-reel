import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { durationMs, hasFfmpeg } from "../src/media.js";
import { run } from "../src/runner.js";
import type { Manifest } from "../src/manifest.js";
// @ts-expect-error plain ESM example without types
import { startMarketApp } from "../examples/market-app/server.mjs";

const storyboard = new URL("../examples/market.storyboard.yaml", import.meta.url).pathname;

// Records real video: needs Playwright's Chromium and ffmpeg with libass.
describe.skipIf(!hasFfmpeg())("two actors, end to end", () => {
  let app: { url: string; close(): Promise<void> };
  let out: string;
  beforeAll(async () => {
    app = await startMarketApp(0);
    process.env.MARKET_URL = app.url;
    process.env.MARKET_PASSWORD = "demo-password";
    out = join(await mkdtemp(join(tmpdir(), "uat-reel-")), "market");
  });
  afterAll(async () => {
    await app?.close();
  });

  it("records separate sessions with captures, an off-camera step and a jump cut, then reshoots one scene", { timeout: 240_000 }, async () => {
    const { manifest } = await run({ storyboard, out, mode: "record" });
    expect(manifest.error).toBeUndefined();
    expect(manifest.scenes.map((s) => s.actor)).toEqual(["ana", "sam", "ana"]);
    expect(manifest.cuts.length).toBeGreaterThan(0);
    expect(manifest.cues.map((c) => c.text)).toContain("Sam can't ship ORD-1001, so he refunds it.");
    const segments = manifest.segments.filter((s) => s.scene === "refund");
    expect(segments.length).toBeGreaterThanOrEqual(3); // chapter, then after the off-camera goto, then after the cut
    for (let i = 1; i < manifest.segments.length; i++) expect(manifest.segments[i]!.start).toBe(manifest.segments[i - 1]!.end);
    expect(Math.abs(durationMs("video.mp4", out)! - manifest.durationMs)).toBeLessThan(250);
    expect(readFileSync(join(out, "review/REVIEW.md"), "utf8")).toMatch(/## Jump cuts\n\n[^\n]*\n\n- \d/);

    const kept = statSync(join(out, "scenes/order-001.webm")).mtimeMs;
    const again = await run({ storyboard, out, mode: "record", from: "sees-refund" });
    expect(again.manifest.ok).toBe(true);
    expect(statSync(join(out, "scenes/order-001.webm")).mtimeMs).toBe(kept);
    expect(again.manifest.cues.map((c) => c.text)).toContain("Sam can't ship ORD-1001, so he refunds it.");
    expect(existsSync(join(out, "video.mp4"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
    expect(saved.scenes).toHaveLength(3);
  });

  it("reshoots the whole film from reproduce.sh alone", { timeout: 240_000 }, async () => {
    const script = readFileSync(join(out, "reproduce.sh"), "utf8");
    expect(script).toContain(`export MARKET_URL='${app.url}'`);
    expect(script).not.toContain("demo-password");
    expect(script).not.toContain("--from");

    // The script must supply MARKET_URL itself and ask for the secret.
    const { MARKET_URL: _, MARKET_PASSWORD: __, ...env } = process.env;
    const bash = (args: string[], extra: Record<string, string> = {}) =>
      new Promise<{ code: number | null; stderr: string }>((done) => {
        // Async: the market app answers from this process.
        const child = spawn("bash", [join(out, "reproduce.sh"), ...args], { env: { ...env, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => done({ code, stderr }));
      });
    const missing = await bash([]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("set MARKET_PASSWORD first");

    const again = join(out, "..", "market-again");
    const rerun = await bash(["--out", again], { MARKET_PASSWORD: "demo-password" });
    expect(rerun.code, rerun.stderr).toBe(0);
    const first = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
    const second = JSON.parse(readFileSync(join(again, "manifest.json"), "utf8")) as Manifest;
    expect(second.ok).toBe(true);
    expect(second.scenes.map((s) => s.id)).toEqual(first.scenes.map((s) => s.id));
    expect(second.cues.map((c) => c.text)).toEqual(first.cues.map((c) => c.text));
    expect(second.reproduce?.sha256).toBe(first.reproduce?.sha256);
    expect(existsSync(join(again, "video.mp4"))).toBe(true);
  });
});

describe("overlay inside a modal dialog", () => {
  it("draws the box, dim and cursor in the dialog's top layer", { timeout: 60_000 }, async () => {
    const { chromium } = await import("playwright");
    const { readFile } = await import("node:fs/promises");
    const { createRequire } = await import("node:module");
    const { dirname } = await import("node:path");
    const { installOverlay } = await import("../src/overlay-page.js");
    const dist = dirname(createRequire(import.meta.url).resolve("driver.js"));
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: await readFile(join(dist, "driver.js.iife.js"), "utf8") });
      await context.addInitScript(installOverlay, { driverCss: await readFile(join(dist, "driver.css"), "utf8") });
      const page = await context.newPage();
      await page.goto(new URL("./fixtures/dialog.html", import.meta.url).href);
      await page.click("#open");
      const placed = await page.locator("#ref").evaluate(async (el) => {
        await window.__uatReel.highlight(el, { label: "Bank reference", color: "#ff1f3d", width: 3, padding: 3, dim: 0.35 });
        await window.__uatReel.cursorTo(10, 10, 0);
        const inDialog = (selector: string) => Boolean(document.querySelector(selector)?.closest("dialog:modal"));
        return { box: inDialog("#uat-reel-box"), dim: inDialog(".driver-overlay"), cursor: inDialog("#uat-reel-cursor") };
      });
      expect(placed).toEqual({ box: true, dim: true, cursor: true });
      // The runner clears boxes before acting, as the dim takes pointer input.
      await page.evaluate(() => window.__uatReel.clear());
      expect(await page.locator(".driver-overlay").count()).toBe(0);
      await page.click("text=Record");
      await page.evaluate(() => window.__uatReel.cursorTo(20, 20, 0));
      expect(await page.evaluate(() => document.getElementById("uat-reel-cursor")?.parentElement === document.body)).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
