import { wrap } from "./captions.js";
import { actionOf, targetOf, type Storyboard } from "./schema.js";
import { varsUsed } from "./vars.js";

export interface LintFinding {
  level: "error" | "warn";
  where: string;
  message: string;
}

const MAX_STEPS_PER_SCENE = 15;
const MAX_CAPTION_WORDS = 18;
const SILENT_STEPS = 4;

/** Rules the schema cannot express: coverage, caption fit, box use and selector brittleness. */
export function lint(sb: Storyboard): LintFinding[] {
  const out: LintFinding[] = [];
  const err = (where: string, message: string) => out.push({ level: "error", where, message });
  const warn = (where: string, message: string) => out.push({ level: "warn", where, message });

  const acceptanceIds = new Set<string>();
  for (const ac of sb.acceptance) {
    if (acceptanceIds.has(ac.id)) err(`acceptance.${ac.id}`, "duplicate acceptance id");
    acceptanceIds.add(ac.id);
  }
  const covered = new Set<string>();
  const sceneIds = new Set<string>();
  const captured = new Set<string>();
  const actorNames = Object.keys(sb.actors ?? {});

  if (sb.scenes.every((scene) => scene.offCamera)) err("scenes", "every scene is off camera, so nothing is recorded");
  for (const [name, actor] of Object.entries(sb.actors ?? {})) {
    (actor.signIn ?? []).forEach((step, i) => {
      const where = `actors.${name}.signIn[${i}]`;
      if (step.say || step.box !== undefined) warn(where, "sign-in runs off camera; its captions and boxes are never seen");
      if (actionOf(step) === "capture") err(where, "capture in sign-in; capture in a scene so the order of values is clear");
      for (const name of varsUsed(step)) err(where, `{{${name}}} in sign-in; sign-in runs before any capture`);
    });
  }

  for (const scene of sb.scenes) {
    const at = `scenes.${scene.id}`;
    if (sceneIds.has(scene.id)) err(at, "duplicate scene id");
    sceneIds.add(scene.id);

    if (actorNames.length > 0 && scene.actor === undefined) err(at, `scene needs an actor (${actorNames.join(", ")})`);
    if (scene.actor !== undefined && !actorNames.includes(scene.actor)) {
      err(at, actorNames.length ? `unknown actor ${scene.actor}` : "actor needs an actors: section");
    }
    if (scene.offCamera && scene.covers.length > 0) {
      err(at, "an off-camera scene cannot prove acceptance criteria; nobody sees it");
    }

    for (const id of scene.covers) {
      if (!acceptanceIds.has(id)) err(at, `covers unknown acceptance id ${id}`);
      covered.add(id);
    }
    if (sb.acceptance.length > 0 && scene.covers.length === 0 && !scene.offCamera) {
      warn(at, "scene covers no acceptance criterion; is it needed?");
    }
    if (scene.steps.length > MAX_STEPS_PER_SCENE && !scene.offCamera) {
      warn(at, `${scene.steps.length} steps; split scenes over ${MAX_STEPS_PER_SCENE} so viewers keep their place`);
    }

    let silent = 0;
    let sawSay = false;
    let sawExpect = false;
    scene.steps.forEach((step, i) => {
      const where = `${at}.steps[${i}]`;
      const action = actionOf(step);
      for (const name of varsUsed(step)) {
        if (!captured.has(name)) err(where, `{{${name}}} is used before any step captures it`);
      }
      if (action === "capture" && step.as) captured.add(step.as);
      if ((scene.offCamera || step.offCamera) && (step.say || step.box !== undefined)) {
        warn(where, "off camera: this caption or box is never seen");
      }

      if (step.say) {
        sawSay = true;
        silent = 0;
        const max = sb.captions.maxLineChars * sb.captions.maxLines;
        const lines = wrap(step.say, sb.captions.maxLineChars);
        if (lines.length > sb.captions.maxLines) {
          err(where, `caption wraps to ${lines.length} lines (max ${sb.captions.maxLines}, about ${max} chars); shorten or split it`);
        }
        const words = step.say.trim().split(/\s+/).length;
        if (words > MAX_CAPTION_WORDS) warn(where, `caption has ${words} words; aim for ${MAX_CAPTION_WORDS} or fewer`);
      } else if (action && action !== "wait" && !scene.offCamera && !step.offCamera) {
        silent += 1;
        if (silent === SILENT_STEPS) warn(where, `${SILENT_STEPS} steps in a row without a caption`);
      }

      if (action === "expect") sawExpect = true;
      if (typeof step.box === "string" && step.box.length > 40) {
        warn(where, "box label over 40 chars; keep labels to a few words and put detail in note");
      }

      const target = targetOf(step);
      if (typeof step.box === "string" && target && sameText(step.box, controlName(target))) {
        warn(where, `box label "${step.box}" repeats the control's own name; use box: true or say what the box proves`);
      }
      if (target) {
        for (const smell of brittleSelector(target)) warn(where, `selector ${JSON.stringify(target)}: ${smell}`);
      }
      if (action === "wait" && (step.wait ?? 0) > 5000) {
        warn(where, "wait over 5s; wait for an element (waitFor/expect) instead of a fixed time");
      }
    });

    if (!sawSay && !scene.offCamera) warn(at, "scene has no caption");
    if (scene.covers.length > 0 && !sawExpect) {
      err(at, "scene claims acceptance coverage but has no expect step to prove it");
    }
  }

  for (const ac of sb.acceptance) {
    if (!covered.has(ac.id)) err(`acceptance.${ac.id}`, "no scene covers this criterion");
  }
  return out;
}

export function brittleSelector(selector: string): string[] {
  const smells: string[] = [];
  if (/^(xpath=|\/\/)/.test(selector)) smells.push("XPath; prefer role=, text= or data-testid");
  if (/:nth-(child|of-type)|>>\s*nth=/.test(selector)) smells.push("positional; breaks when order changes");
  if (/\.[a-z0-9_-]*[0-9a-f]{5,}\b|\b(css|sc|jsx)-[a-z0-9]+/i.test(selector)) smells.push("looks like a generated class name");
  if (!/^(role=|text=|data-testid=|\[data-testid|#|label=|placeholder=|internal:)/.test(selector)) {
    const depth = selector.split(/\s+|>/).filter(Boolean).length;
    if (depth >= 4) smells.push("long CSS chain; tie it to role, label or data-testid");
  }
  return smells;
}

/** The accessible name or text a selector targets, when it names one. */
export function controlName(selector: string): string | undefined {
  return /\[name=["']?([^"'\]]+)["']?/.exec(selector)?.[1] ?? /^text=["']?([^"']+)["']?$/.exec(selector)?.[1];
}

function sameText(a: string, b: string | undefined): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return b !== undefined && norm(a) === norm(b);
}

export function formatFindings(findings: LintFinding[]): string {
  if (findings.length === 0) return "lint: clean";
  return findings.map((f) => `${f.level === "error" ? "error" : "warn "}  ${f.where}  ${f.message}`).join("\n");
}
