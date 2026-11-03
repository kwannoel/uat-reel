#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { formatFindings, lint } from "./lint.js";
import { loadStoryboard, StoryboardError } from "./load.js";
import { buildReviewPack } from "./reviewpack.js";
import { defaultOut, run, VERSION } from "./runner.js";
import { StoryboardSchema } from "./schema.js";
import { STARTER } from "./starter.js";

const HELP = `uat-reel ${VERSION}: storyboarded UAT videos with red-box highlights and captions

Usage
  uat-reel init <file.storyboard.yaml>     write a starter storyboard
  uat-reel lint <storyboard>               validate schema and authoring rules (exit 1 on errors)
  uat-reel rehearse <storyboard>           run without video; screenshot every box and expect
  uat-reel record <storyboard>             record video, captions and a review pack
  uat-reel review-pack <out-dir>           rebuild review/ from an existing recording
  uat-reel schema                          print the storyboard JSON Schema

Options
  --out <dir>        output folder (default out/<name> or out/<name>-rehearse)
  --base-url <url>   override the storyboard's baseUrl
  --headed           show the browser
  --timeout <ms>     per-action timeout (default 10000)
  --no-post          record only: skip ffmpeg (no mp4, no review pack)
  --from <scene>     record only: replay earlier scenes unrecorded, reuse their saved takes,
                     and record this scene and every later one
  --no-setup         skip the storyboard's setup commands
  --no-services      don't start the storyboard's services; film the app already running
  --dir <folder>     where setup runs and relative paths resolve (default the storyboard's folder)

Every rehearse and record writes reproduce.sh into its output folder: bash <out>/reproduce.sh reshoots it.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "base-url": { type: "string" },
      headed: { type: "boolean", default: false },
      timeout: { type: "string" },
      "no-post": { type: "boolean", default: false },
      from: { type: "string" },
      "no-setup": { type: "boolean", default: false },
      "no-services": { type: "boolean", default: false },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, arg] = positionals;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  const need = (what: string) => {
    if (!arg) throw new UsageError(`${command} needs ${what}`);
    return arg;
  };

  switch (command) {
    case "init": {
      const file = need("a file path");
      if (await access(file).then(() => true, () => false)) throw new UsageError(`${file} already exists`);
      await writeFile(file, STARTER);
      console.log(`wrote ${file}`);
      return 0;
    }
    case "lint": {
      // Lint must run without secrets (CI, review): unset variables lint as placeholders.
      let unset: string[] = [];
      const sb = await loadStoryboard(need("a storyboard"), { onMissingEnv: (names) => (unset = names) });
      const findings = lint(sb);
      if (unset.length) console.log(`note: not set, linted as placeholders: ${unset.join(", ")}`);
      console.log(formatFindings(findings));
      return findings.some((f) => f.level === "error") ? 1 : 0;
    }
    case "schema":
      console.log(JSON.stringify(z.toJSONSchema(StoryboardSchema, { io: "input" }), null, 2));
      return 0;
    case "rehearse":
    case "record": {
      const storyboard = need("a storyboard");
      const { manifest, out } = await run({
        storyboard,
        mode: command,
        out: values.out ?? defaultOut(storyboard, command),
        baseUrl: values["base-url"],
        headed: values.headed,
        timeoutMs: values.timeout ? Number(values.timeout) : undefined,
        post: !values["no-post"],
        from: values.from,
        setup: !values["no-setup"],
        dir: values.dir,
        services: !values["no-services"],
        log: (line) => console.error(`uat-reel: ${line}`),
      });
      const lines = [`${manifest.ok ? "ok" : "FAILED"}: ${out}`];
      if (command === "rehearse") lines.push(`  shots: ${manifest.shots.length} in ${out}/shots`);
      for (const [k, v] of Object.entries(manifest.outputs)) lines.push(`  ${k}: ${out}/${v}`);
      if (manifest.outputs.video) lines.push(`  review: ${out}/review/REVIEW.md`);
      if (manifest.error) lines.push(`  error: ${manifest.error.scene} step ${manifest.error.step + 1}: ${manifest.error.message}`);
      console.log(lines.join("\n"));
      return manifest.ok ? 0 : 1;
    }
    case "review-pack": {
      const dir = await buildReviewPack(need("a recording folder"));
      console.log(`wrote ${dir}/REVIEW.md`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof StoryboardError || err instanceof UsageError) console.error(`uat-reel: ${err.message}`);
    else console.error(err);
    if (err instanceof UsageError) console.error(HELP);
    process.exit(2);
  },
);
