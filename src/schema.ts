import { z } from "zod";

/** Action keys a step may carry. Exactly one per step, except a narration beat (`say` alone). */
export const ACTION_KEYS = [
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "scroll",
  "waitFor",
  "wait",
  "expect",
  "highlight",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

/** Actions whose value is a Playwright selector, so they can carry a red box. */
export const TARGET_ACTIONS: ReadonlySet<ActionKey> = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "hover",
  "scroll",
  "waitFor",
  "expect",
  "highlight",
]);

const target = z
  .string()
  .min(1)
  .describe('Playwright selector, e.g. role=button[name="Save"], text=Checkout, [data-testid=cart]');

export const StepSchema = z
  .object({
    goto: z.string().min(1).optional().describe("URL, absolute or relative to baseUrl / the storyboard file"),
    click: target.optional(),
    fill: target.optional(),
    press: z.string().min(1).optional().describe("Key or chord, e.g. Enter, Control+A"),
    select: target.optional(),
    check: target.optional(),
    uncheck: target.optional(),
    hover: target.optional(),
    scroll: target.optional(),
    waitFor: target.optional(),
    wait: z.number().int().positive().optional().describe("Milliseconds"),
    expect: target.optional().describe("Fails the recording unless the target becomes visible"),
    highlight: target.optional().describe("Red box around the target, no action"),

    value: z.string().optional().describe("Value for fill / select"),
    on: target.optional().describe("Element to focus before press"),
    text: z.string().optional().describe("Text the expect target must contain"),
    secret: z
      .boolean()
      .optional()
      .describe("fill only: value comes from an env var and must go into a password field; typed without animation"),

    say: z.string().min(1).optional().describe("Caption cue that starts at this step"),
    box: z
      .union([z.string().min(1), z.literal(true)])
      .optional()
      .describe("Red box around this step's target before acting; a string is its label"),
    note: z.string().min(1).optional().describe("Longer popover text under the box label"),
    pause: z.number().int().nonnegative().optional().describe("Extra milliseconds after the step"),
  })
  .strict()
  .superRefine((step, ctx) => {
    const keys = ACTION_KEYS.filter((k) => step[k] !== undefined);
    if (keys.length > 1) {
      ctx.addIssue({ code: "custom", message: `step has more than one action: ${keys.join(", ")}` });
      return;
    }
    const action = keys[0];
    if (!action && !step.say) {
      ctx.addIssue({ code: "custom", message: `step needs one action (${ACTION_KEYS.join(", ")}) or a say` });
      return;
    }
    if ((action === "fill" || action === "select") && step.value === undefined) {
      ctx.addIssue({ code: "custom", message: `${action} needs a value` });
    }
    if (step.value !== undefined && action !== "fill" && action !== "select") {
      ctx.addIssue({ code: "custom", message: "value only applies to fill and select" });
    }
    if (step.text !== undefined && action !== "expect") {
      ctx.addIssue({ code: "custom", message: "text only applies to expect" });
    }
    if (step.secret && action !== "fill") {
      ctx.addIssue({ code: "custom", message: "secret only applies to fill" });
    }
    if (step.on !== undefined && action !== "press") {
      ctx.addIssue({ code: "custom", message: "on only applies to press" });
    }
    const boxable = action && (TARGET_ACTIONS.has(action) || (action === "press" && step.on));
    if (step.box !== undefined && !boxable) {
      ctx.addIssue({ code: "custom", message: `box needs a target; ${action ?? "a say-only step"} has none` });
    }
    if (step.note !== undefined && step.box === undefined && action !== "highlight") {
      ctx.addIssue({ code: "custom", message: "note needs a box or highlight" });
    }
  });
export type Step = z.infer<typeof StepSchema>;

export const SceneSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "scene id must be kebab-case"),
    title: z.string().min(1),
    covers: z.array(z.string()).default([]).describe("Acceptance criterion ids this scene demonstrates"),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    baseUrl: z.string().optional(),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .prefault({ width: 1280, height: 720 }),
    storageState: z.string().optional().describe("Playwright storage state file for a signed-in session"),
    acceptance: z
      .array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict())
      .default([]),
    captions: z
      .object({
        cps: z.number().positive().default(15).describe("Reading speed, characters per second"),
        minMs: z.number().int().positive().default(1500),
        maxLineChars: z.number().int().positive().default(42),
        maxLines: z.number().int().positive().default(2),
        band: z.boolean().default(true).describe("Burn captions into a black band under the page so they never cover the app"),
      })
      .strict()
      .prefault({}),
    pacing: z
      .object({
        afterAction: z.number().int().nonnegative().default(500),
        boxHold: z.number().int().nonnegative().default(1200),
        typeDelay: z.number().int().nonnegative().default(45),
        cursorMs: z.number().int().nonnegative().default(450),
        tail: z.number().int().nonnegative().default(1000),
      })
      .strict()
      .prefault({}),
    style: z
      .object({
        boxColor: z.string().default("#ff1f3d"),
        boxWidth: z.number().positive().default(3),
        boxPadding: z.number().nonnegative().default(3),
        dim: z.number().min(0).max(1).default(0.35).describe("Spotlight overlay opacity; 0 disables dimming"),
        cursor: z.boolean().default(true),
        chapters: z.boolean().default(true).describe("Title card at the start and before each scene"),
        sceneChip: z.boolean().default(false).describe("Persistent corner chip with the scene title"),
      })
      .strict()
      .prefault({}),
    scenes: z.array(SceneSchema).min(1),
  })
  .strict();
export type Storyboard = z.infer<typeof StoryboardSchema>;

export function actionOf(step: Step): ActionKey | undefined {
  return ACTION_KEYS.find((k) => step[k] !== undefined);
}

/** The selector a red box for this step should surround, if any. */
export function targetOf(step: Step): string | undefined {
  const action = actionOf(step);
  if (!action) return undefined;
  if (action === "press") return step.on;
  if (TARGET_ACTIONS.has(action)) return step[action] as string;
  return undefined;
}
