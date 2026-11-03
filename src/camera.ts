import type { Page } from "playwright";

/** A recorded stretch of one page. `start`/`end` are film ms; the file holds at least `end - start`. */
export interface Segment {
  file: string;
  start: number;
  end: number;
}

/**
 * The film clock. In record mode it advances only while a segment is rolling, so every manifest time is
 * a time in the finished video. Rehearse runs on the wall clock and never records.
 */
export class Camera {
  readonly segments: Segment[] = [];
  private rolling: { page: Page; file: string; wallStart: number; filmStart: number } | null = null;
  private filmMs = 0;
  private readonly wallZero = Date.now();

  constructor(
    private readonly opts: {
      record: boolean;
      size: { width: number; height: number };
      /** Absolute path for the next segment file, given its sequence number. */
      path: (seq: number) => { abs: string; rel: string };
    },
  ) {}

  get isRolling(): boolean {
    return this.rolling !== null;
  }

  now(): number {
    if (!this.opts.record) return Date.now() - this.wallZero;
    return this.rolling ? this.rolling.filmStart + (Date.now() - this.rolling.wallStart) : this.filmMs;
  }

  async roll(page: Page): Promise<void> {
    if (!this.opts.record || this.rolling) return;
    const { abs, rel } = this.opts.path(this.segments.length + 1);
    await page.screencast.start({ path: abs, size: this.opts.size, quality: 90, fps: 25 });
    this.rolling = { page, file: rel, wallStart: Date.now(), filmStart: this.filmMs };
  }

  /** Stops the current segment. Playwright pads the file past this point; the join trims it. */
  async cut(): Promise<void> {
    if (!this.rolling) return;
    const { page, file, filmStart } = this.rolling;
    this.filmMs = this.now();
    this.rolling = null;
    this.segments.push({ file, start: filmStart, end: this.filmMs });
    await page.screencast.stop();
  }
}
