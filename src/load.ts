import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { literalSecrets, substituteEnv } from "./env.js";
import { StoryboardSchema, type Storyboard } from "./schema.js";

export class StoryboardError extends Error {
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(`${file}: invalid storyboard\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

export interface ParseOptions {
  env?: Record<string, string | undefined>;
  /** Lint without secrets: unset variables become `<NAME>` placeholders and are reported, not fatal. */
  onMissingEnv?: (names: string[]) => void;
}

export function parseStoryboard(source: string, file = "<inline>", opts: ParseOptions = {}): Storyboard {
  const env = opts.env ?? process.env;
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    throw new StoryboardError(file, [(err as Error).message]);
  }
  const secrets = literalSecrets(raw);
  if (secrets.length) throw new StoryboardError(file, secrets);
  const { value, missing } = substituteEnv(raw, env, Boolean(opts.onMissingEnv));
  if (missing.length && opts.onMissingEnv) opts.onMissingEnv(missing);
  else if (missing.length) {
    throw new StoryboardError(file, missing.map((name) => `environment variable ${name} is not set (use \${${name}:-default} for a fallback)`));
  }
  const result = StoryboardSchema.safeParse(value);
  if (!result.success) {
    throw new StoryboardError(file, result.error.issues.map(formatIssue));
  }
  return result.data;
}

export async function loadStoryboard(file: string, opts: ParseOptions = {}): Promise<Storyboard> {
  return parseStoryboard(await readFile(file, "utf8"), file, opts);
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
    .join("")
    .replace(/^\./, "");
  return path ? `${path}: ${issue.message}` : issue.message;
}
