import type { Step } from "./schema.js";

/** `{{name}}`: a value captured earlier in the run. Resolved at run time, unlike `${ENV}`. */
const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Variable names referenced anywhere in a step's string fields. */
export function varsUsed(step: Step): string[] {
  const names = new Set<string>();
  for (const value of Object.values(step)) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(VAR)) names.add(match[1]!);
  }
  return [...names];
}

/** A copy of the step with every `{{name}}` replaced; throws on a name nothing has captured. */
export function interpolate(step: Step, vars: Record<string, string>): Step {
  const fill = (value: string) =>
    value.replace(VAR, (_, name: string) => {
      if (!(name in vars)) throw new Error(`{{${name}}} is used before any step captured it`);
      return vars[name]!;
    });
  return Object.fromEntries(
    Object.entries(step).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value]),
  ) as Step;
}

/** What a capture step stores: the whole text, or the first group (else the match) of `pattern`. */
export function captured(text: string, pattern: string | undefined): string {
  const trimmed = text.trim();
  if (pattern === undefined) return trimmed;
  const match = new RegExp(pattern, "u").exec(trimmed);
  if (!match) throw new Error(`captured text ${JSON.stringify(trimmed.slice(0, 120))} does not match /${pattern}/`);
  return match[1] ?? match[0];
}
