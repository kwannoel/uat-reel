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

describe("actors, captures and off-camera work", () => {
  const story = (body: string) => `title: T
actors:
  buyer:
    baseUrl: http://localhost:1
  seller:
    baseUrl: http://localhost:2
scenes:
${body}`;

  it("parses actors, capture and off-camera scenes", async () => {
    const sb = parseStoryboard(
      story(`  - id: a
    title: A
    actor: buyer
    steps:
      - capture: "[data-testid=order]"
        as: order
        pattern: "(ORD-\\\\d+)"
  - id: b
    title: B
    actor: seller
    offCamera: true
    steps:
      - click: role=link[name="{{order}}"]`),
    );
    expect(sb.scenes[1]!.offCamera).toBe(true);
    expect(sb.pacing.cutAfter).toBe(1000);
    expect(lint(sb).filter((f) => f.level === "error")).toEqual([]);
  });

  it("rejects capture without as, and as without capture", () => {
    expect(() => parseStoryboard(story(`  - id: a\n    title: A\n    actor: buyer\n    steps:\n      - capture: "#x"`))).toThrow(/capture needs as/);
    expect(() => parseStoryboard(story(`  - id: a\n    title: A\n    actor: buyer\n    steps:\n      - click: "#x"\n        as: y`))).toThrow(/as and pattern only apply to capture/);
  });

  it("lints actors, variable order and off-camera captions", () => {
    const sb = parseStoryboard(
      story(`  - id: a
    title: A
    steps:
      - click: role=link[name="{{order}}"]
  - id: b
    title: B
    actor: nobody
    steps:
      - goto: /
  - id: c
    title: C
    actor: buyer
    offCamera: true
    steps:
      - goto: /
        say: Nobody reads this.`),
    );
    const found = lint(sb).map((f) => `${f.level} ${f.where} ${f.message}`);
    expect(found).toContain("error scenes.a scene needs an actor (buyer, seller)");
    expect(found).toContain("error scenes.a.steps[0] {{order}} is used before any step captures it");
    expect(found).toContain("error scenes.b unknown actor nobody");
    expect(found).toContain("warn  scenes.c.steps[0] off camera: this caption or box is never seen".replace("warn  ", "warn "));
  });

  it("refuses a literal secret in an actor's sign-in", () => {
    expect(() =>
      parseStoryboard(`title: T
actors:
  a:
    signIn:
      - fill: "#pw"
        value: hunter2
        secret: true
scenes:
  - id: x
    title: X
    actor: a
    steps:
      - goto: /`),
    ).toThrow(/actors\.a\.signIn\[0\]: secret value must be a single env reference/);
  });

  it("interpolates captured values and keeps pattern groups", async () => {
    const { interpolate, captured, varsUsed } = await import("../src/vars.js");
    const step = { click: 'role=button[name="Refund {{order}}"]', say: "Refund {{ order }}." };
    expect(varsUsed(step)).toEqual(["order"]);
    expect(interpolate(step, { order: "ORD-7" })).toEqual({ click: 'role=button[name="Refund ORD-7"]', say: "Refund ORD-7." });
    expect(() => interpolate(step, {})).toThrow(/used before any step captured it/);
    expect(captured("  Order ORD-12 placed ", "(ORD-\\d+)")).toBe("ORD-12");
    expect(captured(" 185.30 ", undefined)).toBe("185.30");
    expect(() => captured("none", "(ORD-\\d+)")).toThrow(/does not match/);
  });

  it("trims each segment to its recorded length when joining", async () => {
    const { joinList } = await import("../src/media.js");
    expect(joinList([{ file: "scenes/a-001.webm", ms: 10266 }, { file: "scenes/it's.webm", ms: 0 }])).toBe(
      "ffconcat version 1.0\nfile 'scenes/a-001.webm'\noutpoint 10.266\nfile 'scenes/it'\\''s.webm'\noutpoint 0.001\n",
    );
  });
});

describe("hidden expects", () => {
  it("accepts hidden on expect and waitFor only, without text or box", () => {
    const one = (step: string) => `title: T\nscenes:\n  - id: a\n    title: A\n    steps:\n${step}`;
    expect(parseStoryboard(one(`      - expect: role=dialog\n        hidden: true`)).scenes[0]!.steps[0]!.hidden).toBe(true);
    expect(() => parseStoryboard(one(`      - click: "#x"\n        hidden: true`))).toThrow(/hidden only applies to expect and waitFor/);
    expect(() => parseStoryboard(one(`      - expect: role=dialog\n        hidden: true\n        text: x`))).toThrow(/nothing to show/);
  });
});

describe("off-camera lint", () => {
  it("does not ask an off-camera scene for captions, coverage or brevity", () => {
    const steps = Array.from({ length: 16 }, () => "      - click: \"#x\"").join("\n");
    const sb = parseStoryboard(`title: T
acceptance:
  - id: AC1
    text: works
scenes:
  - id: a
    title: A
    offCamera: true
    steps:
${steps}
  - id: b
    title: B
    covers: [AC1]
    steps:
      - expect: text=Done
        say: Done.`);
    expect(lint(sb).filter((f) => f.where.startsWith("scenes.a"))).toEqual([]);
  });
});

describe("reproduce script", () => {
  it("finds env references and which a secret step reads", async () => {
    const { envRefs } = await import("../src/env.js");
    const { parse } = await import("yaml");
    const refs = envRefs(
      parse(`
baseUrl: \${APP_URL:-http://x}
setup: [[reset, "\${DB_URL}"]]
note: "$\${LITERAL}"
scenes:
  - steps:
      - fill: "#p"
        value: \${APP_PASSWORD}
        secret: true
`),
    );
    expect(refs).toEqual({ names: ["APP_PASSWORD", "APP_URL", "DB_URL"], secret: ["APP_PASSWORD"] });
  });

  it("never writes a secret down", async () => {
    const { isSecretEnv } = await import("../src/reproduce.js");
    expect(isSecretEnv("PIN", "1", ["PIN"])).toBe(true);
    expect(isSecretEnv("API_TOKEN", "t", [])).toBe(true);
    expect(isSecretEnv("DATABASE_URL", "postgres://u:hunter2@db/x", [])).toBe(true);
    expect(isSecretEnv("DATABASE_URL", "postgres://localhost:5432/x", [])).toBe(false);
  });

  it("quotes values, keeps the folder relative and passes the take's options", async () => {
    const { reproduceScript } = await import("../src/reproduce.js");
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const script = reproduceScript({
      title: "It's done",
      mode: "record",
      startedAt: "2026-11-03T00:00:00.000Z",
      out: "/work/app/out/film",
      dir: "/work/app/films",
      args: ["--timeout", "20000"],
      env: { NAME: "O'Brien $HOME", UNSET: undefined, PASS: "x" },
      secrets: ["PASS"],
      reproduction: {
        script: "reproduce.sh",
        storyboard: "storyboard.yaml",
        source: "../../films/film.storyboard.yaml",
        sha256: "abc",
        uatReel: { version: "0.1.0" },
        playwright: "1.64.1",
        secrets: ["PASS"],
      },
    });
    expect(script).toContain(`dir="\${UAT_REEL_DIR:-$here/../../films}"`);
    expect(script).toContain("# UNSET was unset");
    expect(script).not.toContain("PASS='x'");
    expect(script).toMatch(/exec "\$\{uat_reel\[@\]\}" record "\$here\/storyboard.yaml" --dir "\$dir" --out "\$here" '--timeout' '20000' "\$@"$/m);
    const file = join(mkdtempSync(join(tmpdir(), "uat-reel-sh-")), "reproduce.sh");
    writeFileSync(file, script);
    execFileSync("/bin/bash", ["-n", file]);
    // The quoted value survives bash intact.
    const head = script.split("\nif [[ -n \"${UAT_REEL")[0]!.replace(/^: .*$/m, "");
    writeFileSync(file, `${head}\nprintf %s "$NAME"\n`);
    expect(execFileSync("/bin/bash", [file], { encoding: "utf8", env: { PATH: process.env.PATH } })).toBe("O'Brien $HOME");
  });
});
