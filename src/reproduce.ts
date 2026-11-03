import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Facts about a take that `reproduce.sh` needs; also kept in `manifest.reproduce`. */
export interface Reproduction {
  script: string;
  storyboard: string;
  /** The storyboard the take ran, relative to the output folder. */
  source: string;
  sha256: string;
  uatReel: { version: string; commit?: string; dirty?: boolean };
  playwright: string;
  ffmpeg?: string;
  /** Variables the script requires instead of writing down. */
  secrets: string[];
}

export interface ScriptInput {
  title: string;
  mode: "record" | "rehearse";
  startedAt: string;
  out: string;
  /** Where setup runs and relative paths resolve. */
  dir: string;
  /** Options after `<storyboard> --dir --out`, for example `--timeout 20000`. */
  args: string[];
  /** Values to export; `undefined` means unset when the take ran (the storyboard fallback applies). */
  env: Record<string, string | undefined>;
  secrets: string[];
  reproduction: Reproduction;
}

const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY/i;
const URL_CREDENTIALS = /:\/\/[^/@\s]*:[^/@\s]*@/;

/** A variable never written into the script: read by a secret step, named like a secret, or holding URL credentials. */
export function isSecretEnv(name: string, value: string | undefined, secretSteps: string[]): boolean {
  return secretSteps.includes(name) || SECRET_NAME.test(name) || (value !== undefined && URL_CREDENTIALS.test(value));
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.js");

/** The uat-reel checkout's commit, when it runs from one. */
export function toolCommit(): { commit?: string; dirty?: boolean } {
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) return {};
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", PACKAGE_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { commit: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain").trim() !== "" };
  } catch {
    return {};
  }
}

export function playwrightVersion(): string {
  return (require("playwright/package.json") as { version: string }).version;
}

export function ffmpegVersion(): string | undefined {
  try {
    return /ffmpeg version (\S+)/.exec(execFileSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))?.[1];
  } catch {
    return undefined;
  }
}

/** Single-quotes for bash. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function reproduceScript(input: ScriptInput): string {
  const r = input.reproduction;
  const tool = [r.uatReel.version, r.uatReel.commit && `git ${r.uatReel.commit.slice(0, 12)}${r.uatReel.dirty ? ", uncommitted changes" : ""}`]
    .filter(Boolean)
    .join(", ");
  const dir = relative(input.out, input.dir) || ".";
  const values = Object.entries(input.env).filter(([name, v]) => v !== undefined && !input.secrets.includes(name));
  const unset = Object.entries(input.env).filter(([name, v]) => v === undefined && !input.secrets.includes(name));
  const lines = [
    "#!/usr/bin/env bash",
    `# Reproduces the uat-reel ${input.mode} of "${input.title.replace(/\n/g, " ")}".`,
    `#   take:        ${input.startedAt}`,
    `#   uat-reel:    ${tool}`,
    `#   playwright:  ${r.playwright}`,
    ...(r.ffmpeg ? [`#   ffmpeg:      ${r.ffmpeg}`] : []),
    `#   storyboard:  ${r.source} (copy: ${r.storyboard}, sha256 ${r.sha256})`,
    "#",
    "# Usage: bash reproduce.sh [uat-reel options]",
    "# Reshoots the whole film into this folder; pass --out <dir> to keep this take.",
    "set -euo pipefail",
    'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    "",
    "# Setup commands run, and relative paths resolve, in the storyboard's folder.",
    `dir="\${UAT_REEL_DIR:-$here/${dir.replace(/(["\\$`])/g, "\\$1")}}"`,
  ];
  if (values.length || unset.length) {
    lines.push("", "# The values this take used; a variable that is already set wins.");
    for (const [name, value] of values) lines.push(`[[ -n "\${${name}+set}" ]] || export ${name}=${q(value!)}`);
    for (const [name] of unset) lines.push(`# ${name} was unset: the storyboard fallback applies.`);
  }
  if (input.secrets.length) {
    lines.push("", "# Secrets are never written down; set these first.");
    for (const name of input.secrets) lines.push(`: "\${${name}:?set ${name} first}"`);
  }
  lines.push(
    "",
    'if [[ -n "${UAT_REEL:-}" ]]; then',
    '  read -r -a uat_reel <<<"$UAT_REEL"',
    `elif [[ -f ${q(CLI_PATH)} ]]; then`,
    `  uat_reel=(node ${q(CLI_PATH)})`,
    "else",
    `  uat_reel=(npx --yes ${q(`uat-reel@${r.uatReel.version}`)})`,
    "fi",
    'version="$("${uat_reel[@]}" --version)"',
    `[[ "$version" == ${q(r.uatReel.version)} ]] || echo "reproduce.sh: this take used uat-reel ${r.uatReel.version}; running $version" >&2`,
    "",
    `exec "\${uat_reel[@]}" ${input.mode} "$here/${r.storyboard}" --dir "$dir" --out "$here"${input.args.map((a) => ` ${q(a)}`).join("")} "$@"`,
    "",
  );
  return lines.join("\n");
}
