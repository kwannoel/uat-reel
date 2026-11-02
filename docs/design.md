# uat-reel design

## Problem

UAT sign-off usually means someone screen-records themselves clicking through a feature. The clip is
unrepeatable, loses its meaning once the UI changes, and depends on the viewer to guess what they are
supposed to notice. We want UAT videos that are:

- **scripted**, so they can be re-recorded on every release with one command;
- **self-explaining**: captions say what is happening and red boxes show where to look;
- **evidence**: assertions in the script fail the recording if the app misbehaves;
- **reviewable by an agent** that cannot watch video, through extracted frames with the expected content
  written beside each one.

## Shape

Two deliverables in one repository:

1. **`uat-reel` CLI and library** (TypeScript, Node 20+) that wraps Playwright (recording and actions) and
   driver.js (spotlight and labels), with ffmpeg doing the post-processing.
2. **`skills/uat-reel/` skill**, a plain `SKILL.md` folder that walks an agent through Storyboard,
   Subtitling, Highlighting and Recording, with an adversarial review gate after each.

## Storyboard file

A storyboard is YAML (`*.storyboard.yaml`) so humans and agents can both read and diff it.

```yaml
title: Guest checkout
baseUrl: http://localhost:3000
acceptance:
  - id: AC1
    text: A guest can add a dish to the cart
scenes:
  - id: add-to-cart
    title: Add a dish
    covers: [AC1]
    steps:
      - goto: /menu
        say: The guest opens the menu.
      - click: role=button[name="Add Laksa"]
        box: Add to cart
        say: They add a bowl of laksa.
      - expect: "[data-testid=cart-count]"
        text: "1"
        box: Cart shows one item
```

- A **step** has exactly one action key: `goto`, `click`, `fill`(+`value`), `press`(+optional `on`),
  `select`(+`value`), `check`, `uncheck`, `hover`, `scroll`, `waitFor`, `wait` (ms), `expect`(+optional
  `text`), `highlight`. A step that has only `say` is a narration beat.
- Common modifiers: `say` (a caption cue starts here), `box` (a red box around the step's target before
  the action; a string becomes the label), `note` (longer popover text), `pause` (extra ms afterwards).
- Targets are Playwright selector strings. `role=`, `text=` and `data-testid` are preferred, and lint
  warns on brittle CSS.
- `covers` ties scenes to acceptance criteria. Lint fails on criteria that nothing covers and on
  unknown ids.

## Pacing is derived from captions

The runner never moves on from a caption until it has been on screen for
`max(minMs, chars / cps)`. Authors write captions and the video slows down to match them. They don't
tune waits by hand. Every `box` holds for `pacing.boxHold`.

## Recording pipeline

1. Load YAML, then check the zod schema, then lint (errors abort).
2. Launch Chromium. A context init script installs driver.js, its CSS, and the uat-reel overlay
   (`window.__uatReel`) on every document, so overlays survive navigation.
3. `page.screencast.start({ path, size, quality, fps })`, then `t0`.
4. For each scene: a scene chip in the corner, then the steps. Each step:
   `say` (flushing the previous cue's minimum time) → `box` (scroll into view, driver.js spotlight and
   popover, a red box tracked with requestAnimationFrame, hold) → synthetic cursor glides to the target →
   ripple → overlay cleared → Playwright action → `pause`/`afterAction`. For actions that change a value
   (`fill`, `select`, `check`, `uncheck`) and for `expect`/`waitFor`, the box goes up *after* the action,
   so it frames the result rather than an empty control.
   Chapter cards (`page.screencast.showChapter`) open each scene. The first card also carries the
   video title, so the video doesn't open on two cards in a row.
5. Every event is timestamped relative to `t0` into `manifest.json`.
6. On failure: `failure.png`, the error goes into the manifest, the video is still finalised, exit 1. A
   failed UAT recording is evidence too.
7. Post (ffmpeg): `captions.srt` and `captions.vtt` → `video.mp4` with captions burned in (libass)
   into a black band padded under the page (`captions.band`), so captions never cover the app →
   `video.clean.mp4` with soft `mov_text` subs → review pack. The closing cue is held through the tail.

The red box is our own fixed-position `div`, not driver.js's stage, because driver.js's cutout has no
border option and CSS outlines get clipped by `overflow: hidden` ancestors. driver.js still provides the
dimmed spotlight and the label popover. Both are cleared before the real action so they never intercept
pointer events.

Playwright videos do not show a cursor, so the overlay draws one. Without it a viewer can't tell what was
clicked.

## Rehearse mode

`uat-reel rehearse` runs the same script with no video and short holds. It takes a screenshot whenever a
box is showing and after each `expect`, and writes them to `shots/`. It is the fast loop for the
storyboard and highlight review gates.

## Review pack

`review/` holds:

- `frames/chapter-NN.jpg` from each chapter card, `frames/cue-NN.jpg` from the midpoint of each caption
  cue in the final video, and `frames/box-NN.jpg` from about 400 ms after each box appears;
- `contact-NN.jpg`, a 4×4 grid sampled every 2 s, for a quick scan;
- `REVIEW.md`: for every frame, the timestamp, scene, the caption that **should** be visible and the box
  label and target that **should** be visible, plus timing stats (cue time against required reading time,
  gaps with no caption, scene durations).

Putting expected next to actual is what makes an adversarial review possible for an agent that sees
stills.

## Adversarial review gates (skill)

After each authoring stage the skill spawns a **fresh** reviewer agent. The reviewer gets only the
artifact paths and a reviewer brief from `skills/uat-reel/reviewers/`, never the author's reasoning. Its
brief tells it to assume the artifact misleads a stakeholder and to find out how. It returns `PASS` or
`BLOCK` with findings (severity, evidence, fix). The author fixes the blockers, and a new fresh reviewer
re-reviews. After 3 rounds it escalates to the user. Every verdict is appended to
`<name>.reviews.md` next to the storyboard.

| Gate | Input | Reviewer brief |
|---|---|---|
| Storyboard | YAML + rehearse shots + acceptance criteria | `reviewers/storyboard.md` |
| Subtitles | YAML + `lint` output | `reviewers/captions.md` |
| Highlights | rehearse `shots/` + YAML | `reviewers/highlights.md` |
| Final video | `review/` pack + manifest | `reviewers/video.md` |

## Non-goals (v0.1)

- Voice-over and TTS.
- Browsers other than Chromium.
- Multiple simultaneous red boxes (use consecutive `highlight` steps).
- Editing or trimming UI. Re-record instead.
