/** `${NAME}` or `${NAME:-fallback}`; `$${` is a literal `${`. */
const REF = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const WHOLE_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export interface Substitution {
  value: unknown;
  missing: string[];
}

/** Replaces env references in every string value (never in keys) of a parsed YAML document. */
export function substituteEnv(
  raw: unknown,
  env: Record<string, string | undefined>,
  placeholders = false,
): Substitution {
  const missing = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(REF, (match, escaped: string, name: string, fallback: string | undefined) => {
        if (escaped) return match.slice(1);
        const value = env[name] ?? fallback;
        if (value === undefined) missing.add(name);
        return value ?? (placeholders ? `<${name}>` : "");
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return { value: walk(raw), missing: [...missing].sort() };
}

/** Secret fills must read their value from the environment, so the storyboard never holds the secret. */
export function literalSecrets(raw: unknown): string[] {
  const issues: string[] = [];
  const check = (steps: unknown, at: (j: number) => string) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, j) => {
      const s = step as { secret?: unknown; value?: unknown };
      if (s?.secret === true && s.value !== undefined && !(typeof s.value === "string" && WHOLE_REF.test(s.value))) {
        issues.push(`${at(j)}: secret value must be a single env reference such as \${UAT_PASSWORD}, not a literal`);
      }
    });
  };
  const doc = raw as { scenes?: unknown; actors?: unknown };
  if (doc?.actors && typeof doc.actors === "object") {
    for (const [name, actor] of Object.entries(doc.actors)) check((actor as { signIn?: unknown })?.signIn, (j) => `actors.${name}.signIn[${j}]`);
  }
  if (Array.isArray(doc?.scenes)) doc.scenes.forEach((scene, i) => check((scene as { steps?: unknown })?.steps, (j) => `scenes[${i}].steps[${j}]`));
  return issues;
}

/** Variables a parsed storyboard reads, and which of them hold secrets (read by a `secret` step). */
export function envRefs(raw: unknown): { names: string[]; secret: string[] } {
  const names = new Set<string>();
  const secret = new Set<string>();
  const walk = (node: unknown, into: Set<string>[]): void => {
    if (typeof node === "string") {
      for (const [, escaped, name] of node.matchAll(REF)) if (!escaped) for (const set of into) set.add(name!);
    } else if (Array.isArray(node)) node.forEach((n) => walk(n, into));
    else if (node && typeof node === "object") {
      const isSecret = (node as { secret?: unknown }).secret === true;
      for (const v of Object.values(node)) walk(v, isSecret ? [...into, secret] : into);
    }
  };
  walk(raw, [names]);
  return { names: [...names].sort(), secret: [...secret].sort() };
}
