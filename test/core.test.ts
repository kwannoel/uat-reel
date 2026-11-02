import { describe, expect, it } from "vitest";
import { readingMs, toSrt, toVtt, wrap } from "../src/captions.js";
import { brittleSelector, lint } from "../src/lint.js";
import { parseStoryboard, StoryboardError } from "../src/load.js";
import { STARTER } from "../src/starter.js";

const base = (scenes: string, extra = "") => `
title: T
acceptance:
  - id: AC1
    text: works
${extra}
scenes:
${scenes}`;

describe("schema", () => {
  it("parses the starter and applies defaults", () => {
    const sb = parseStoryboard(STARTER);
    expect(sb.viewport).toEqual({ width: 1280, height: 720 });
    expect(sb.captions.cps).toBe(15);
    expect(sb.pacing.boxHold).toBe(1200);
    expect(sb.style.boxColor).toBe("#ff1f3d");
  });

  it("rejects a step with two actions, with a readable path", () => {
    const bad = base(`  - id: a
    title: A
    steps:
      - click: "#x"
        hover: "#y"`);
    expect(() => parseStoryboard(bad)).toThrow(/scenes\[0\]\.steps\[0\]: step has more than one action: click, hover/);
  });

  it("requires value for fill and rejects box on goto", () => {
    const bad = base(`  - id: a
    title: A
    steps:
      - fill: "#name"
      - goto: /
        box: Home`);
    try {
      parseStoryboard(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StoryboardError);
      const issues = (err as StoryboardError).issues.join("\n");
      expect(issues).toMatch(/steps\[0\]: fill needs a value/);
      expect(issues).toMatch(/steps\[1\]: box needs a target; goto has none/);
    }
  });

  it("allows a say-only narration beat and box on press with on", () => {
    const sb = parseStoryboard(
      base(`  - id: a
    title: A
    covers: [AC1]
    steps:
      - say: Intro.
      - press: Enter
        on: role=textbox
        box: Submit
      - expect: text=Done`),
    );
    expect(sb.scenes[0]!.steps).toHaveLength(3);
  });

  it("rejects unknown keys", () => {
    expect(() => parseStoryboard(base(`  - id: a\n    title: A\n    steps:\n      - clik: "#x"`))).toThrow(StoryboardError);
  });
});

describe("lint", () => {
  it("flags uncovered criteria, unknown ids and coverage without an expect", () => {
    const sb = parseStoryboard(
      base(
        `  - id: a
    title: A
    covers: [AC2]
    steps:
      - goto: /
        say: Hi.`,
        "  - id: AC3\n    text: other",
      ),
    );
    const msgs = lint(sb).filter((f) => f.level === "error").map((f) => `${f.where} ${f.message}`);
    expect(msgs).toContain("scenes.a covers unknown acceptance id AC2");
    expect(msgs).toContain("scenes.a scene claims acceptance coverage but has no expect step to prove it");
    expect(msgs).toContain("acceptance.AC1 no scene covers this criterion");
  });

  it("errors on captions that wrap past the line budget", () => {
    const long = "word ".repeat(30).trim();
    const sb = parseStoryboard(base(`  - id: a\n    title: A\n    covers: [AC1]\n    steps:\n      - say: ${long}\n      - expect: text=x`));
    expect(lint(sb).some((f) => f.level === "error" && /wraps to \d+ lines/.test(f.message))).toBe(true);
  });

  it("is clean for the starter", () => {
    expect(lint(parseStoryboard(STARTER)).filter((f) => f.level === "error")).toEqual([]);
  });

  it("warns when a box label repeats the control's name", () => {
    const sb = parseStoryboard(
      base(`  - id: a\n    title: A\n    covers: [AC1]\n    steps:\n      - click: role=button[name="Place order"]\n        box: Place order\n        say: Go.\n      - expect: text=Done\n        box: Order placed`),
    );
    const warns = lint(sb).filter((f) => /repeats the control/.test(f.message));
    expect(warns.map((w) => w.where)).toEqual(["scenes.a.steps[0]"]);
  });

  it("spots brittle selectors and leaves good ones alone", () => {
    expect(brittleSelector("//div[2]/span")).toHaveLength(1);
    expect(brittleSelector("ul > li:nth-child(3)")[0]).toMatch(/positional/);
    expect(brittleSelector(".css-1x2y3z")[0]).toMatch(/generated/);
    expect(brittleSelector("main div section form button")[0]).toMatch(/long CSS chain/);
    expect(brittleSelector('role=button[name="Pay now"]')).toEqual([]);
    expect(brittleSelector("[data-testid=cart-count]")).toEqual([]);
  });
});

describe("captions", () => {
  it("derives reading time from length with a floor", () => {
    expect(readingMs("Hi", { cps: 15, minMs: 1500 })).toBe(1500);
    expect(readingMs("x".repeat(60), { cps: 15, minMs: 1500 })).toBe(4000);
  });

  it("wraps on word boundaries", () => {
    expect(wrap("The guest adds a bowl of laksa to the cart and checks out", 24)).toEqual([
      "The guest adds a bowl of",
      "laksa to the cart and",
      "checks out",
    ]);
  });

  it("writes SRT and VTT timestamps", () => {
    const cues = [{ start: 0, end: 1500, text: "One", scene: "a" }, { start: 61_234, end: 3_725_001, text: "Two", scene: "a" }];
    expect(toSrt(cues, 42)).toBe("1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n00:01:01,234 --> 01:02:05,001\nTwo\n");
    expect(toVtt(cues, 42).startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nOne\n")).toBe(true);
  });
});

describe("captionFilter", () => {
  it("pads a band and sizes text in libass script units", async () => {
    const { captionFilter } = await import("../src/media.js");
    const f = captionFilter("captions.srt", { height: 720, band: true });
    expect(f.startsWith("pad=iw:ih+122:0:0:color=black,subtitles=captions.srt:force_style='")).toBe(true);
    // 30px font on an 842px-tall output, in 288-line script units.
    expect(f).toContain("FontSize=10.26");
    expect(captionFilter("captions.srt", { height: 720, band: false })).not.toContain("pad=");
  });
});

describe("env substitution", () => {
  const sb = (steps: string) => `title: T
baseUrl: \${BASE:-http://localhost:3000}
scenes:
  - id: a
    title: A
    steps:
${steps}`;

  it("fills references, applies fallbacks and keeps escaped ones literal", () => {
    const parsed = parseStoryboard(
      sb(`      - fill: role=textbox[name="Email"]\n        value: \${USER_EMAIL}\n        say: Costs $\${PRICE} today.`),
      "x",
      { env: { USER_EMAIL: "a@example.com" } },
    );
    expect(parsed.baseUrl).toBe("http://localhost:3000");
    expect(parsed.scenes[0]!.steps[0]!.value).toBe("a@example.com");
    expect(parsed.scenes[0]!.steps[0]!.say).toBe("Costs \${PRICE} today.");
  });

  it("lints with placeholders, keeping fallbacks", () => {
    let missing: string[] = [];
    const parsed = parseStoryboard(sb(`      - fill: "#pw"\n        value: \${PW}\n        secret: true`), "x", {
      env: {},
      onMissingEnv: (names) => (missing = names),
    });
    expect(missing).toEqual(["PW"]);
    expect(parsed.baseUrl).toBe("http://localhost:3000");
    expect(parsed.scenes[0]!.steps[0]!.value).toBe("<PW>");
  });

  it("names every missing variable", () => {
    expect(() => parseStoryboard(sb(`      - fill: "#a"\n        value: \${A}\n      - fill: "#b"\n        value: \${B}`), "x", { env: {} })).toThrow(
      /environment variable A is not set[\s\S]*environment variable B is not set/,
    );
  });

  it("refuses a literal secret and secret on non-fill steps", () => {
    expect(() => parseStoryboard(sb(`      - fill: "#pw"\n        value: hunter2\n        secret: true`), "x", { env: {} })).toThrow(/single env reference/);
    expect(() => parseStoryboard(sb(`      - fill: "#pw"\n        value: pre-\${PW}\n        secret: true`), "x", { env: { PW: "x" } })).toThrow(/single env reference/);
    expect(() => parseStoryboard(sb(`      - click: "#pw"\n        secret: true`), "x", { env: {} })).toThrow(/secret only applies to fill/);
    expect(parseStoryboard(sb(`      - fill: "#pw"\n        value: \${PW}\n        secret: true`), "x", { env: { PW: "s3cret" } }).scenes[0]!.steps[0]!.value).toBe("s3cret");
  });
});
