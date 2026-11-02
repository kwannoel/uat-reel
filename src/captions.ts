export interface Cue {
  start: number;
  end: number;
  text: string;
  scene: string;
}

export interface CaptionRules {
  cps: number;
  minMs: number;
  maxLineChars: number;
  maxLines: number;
}

/** How long a caption must stay on screen to be read. */
export function readingMs(text: string, rules: Pick<CaptionRules, "cps" | "minMs">): number {
  return Math.max(rules.minMs, Math.ceil((text.length / rules.cps) * 1000));
}

/** Greedy word wrap. Words longer than a line are left whole rather than split. */
export function wrap(text: string, maxLineChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxLineChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function clock(ms: number, sep: "," | "."): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
}

export function toSrt(cues: Cue[], maxLineChars: number): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${wrap(c.text, maxLineChars).join("\n")}\n`,
    )
    .join("\n");
}

export function toVtt(cues: Cue[], maxLineChars: number): string {
  const body = cues
    .map(
      (c, i) =>
        `${i + 1}\n${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${wrap(c.text, maxLineChars).join("\n")}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
