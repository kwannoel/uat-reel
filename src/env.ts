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
  const scenes = (raw as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return issues;
  scenes.forEach((scene, i) => {
    const steps = (scene as { steps?: unknown })?.steps;
    if (!Array.isArray(steps)) return;
    steps.forEach((step, j) => {
      const s = step as { secret?: unknown; value?: unknown };
      if (s?.secret === true && s.value !== undefined && !(typeof s.value === "string" && WHOLE_REF.test(s.value))) {
        issues.push(`scenes[${i}].steps[${j}]: secret value must be a single env reference such as \${UAT_PASSWORD}, not a literal`);
      }
    });
  });
  return issues;
}
