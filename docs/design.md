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
3. Each scene: run any leading `goto` first and wait for the network to go idle (at most 5 s), so a
   single-page app has finished rendering under the chapter card; then start a segment with
   `page.screencast.start({ path, size, quality, fps })` on that scene's actor page (see
   [Recording segments](#recording-segments-and-jump-cuts)).
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
7. Post (ffmpeg): segments joined into `raw.mp4` → `captions.srt` and `captions.vtt` → `video.mp4` with captions burned in (libass)
   into a black band padded under the page (`captions.band`), so captions never cover the app →
   `video.clean.mp4` with soft `mov_text` subs → review pack. The closing cue is held through the tail.

The red box is our own fixed-position `div`, not driver.js's stage, because driver.js's cutout has no
border option and CSS outlines get clipped by `overflow: hidden` ancestors. driver.js still provides the
dimmed spotlight and the label popover. Both are cleared before the real action so they never intercept
pointer events.

Playwright videos do not show a cursor, so the overlay draws one. Without it a viewer can't tell what was
clicked.

## Actors, captures and off-camera work

Some flows need more than one person: a buyer orders in a shop, a supplier refunds it in a back
office, and the buyer sees the refund. Each person is an **actor**:

```yaml
actors:
  buyer:
    baseUrl: ${SHOP_URL}
    signIn:                       # runs off camera before the actor's first scene
      - goto: /sign-in
      - fill: role=textbox[name="Email"]
        value: ${BUYER_EMAIL}
      - fill: "[data-testid=sign-in-password]"
        value: ${BUYER_PASSWORD}
        secret: true
      - click: role=button[name="Sign in"]
  supplier:
    baseUrl: ${ERP_URL}
    storageState: supplier.json   # or a saved session
scenes:
  - id: order
    actor: buyer
    steps:
      - capture: "[data-testid=order-number]"
        as: order
  - id: refund
    actor: supplier
    steps:
      - click: role=link[name="{{order}}"]
```

- Each actor has its own browser context and page for the whole run, so sessions never mix, even on
  one host. When `actors` is absent, the storyboard's `baseUrl` and `storageState` form a single
  implicit actor and scenes need no `actor`.
- `capture: <selector>` with `as: <name>` stores the element's text, or a form field's value, at run
  time. `pattern` keeps only a regular expression's first group. `{{name}}` inserts it into any later
  string, including selectors, `goto`, `value` and captions. Lint rejects a `{{name}}` used before its
  capture.
- `offCamera: true` on a step or a scene runs it without recording. An off-camera scene moves the app
  along (for example, an approval the film only mentions) and gets no chapter. Chapter cards number
  only the scenes on camera, so the film shows no gaps. Lint warns about
  captions and boxes nobody will see, and rejects `covers` on an off-camera scene.

## Recording segments and jump cuts

The camera records in **segments**: `page.screencast.start` and `stop` on the scene's page. Every
scene is at least one segment, a new segment starts after every off-camera step, and:

- **Jump cuts.** When an action or expect waits on the app for longer than `pacing.cutAfter`
  (default 1000 ms; 0 disables), the screencast stops until the wait ends. The viewer sees a cut
  instead of a spinner. `manifest.cuts` and `REVIEW.md` list every cut.
- **One film clock.** Manifest times advance only while a segment records, so they are film times.
  Playwright pads each segment file with about a second of its last frame; post-processing trims every
  segment to its recorded length (`outpoint`) and joins them into `raw.mp4`.
- **Reshoots.** Each scene's segments and events are saved under `scenes/`. `record --from <scene>`
  replays the earlier scenes unrecorded and at rehearse speed, to rebuild app state and captures, then
  records the named scene and every later one, and joins them with the saved earlier segments.
  The replay is a new run of the app, not the one the reused footage shows. Each take records its
  run (`recordedIn`) and its captures; a replayed capture that differs from the saved one stops the
  run, because the later scenes would film another record. What no capture covers, such as a server
  timestamp, can still disagree, so a joined film lists its runs in `manifest.takes` and REVIEW.md,
  and the final-video reviewer checks each join.
- **Setup.** `setup:` lists commands (an executable and its arguments, no shell) that run before every
  rehearse and record, for example a database reset and fixture load. `--no-setup` skips them.
  `--from` needs setup, or `--no-setup` to replay on the current state deliberately.

## Services

A storyboard can start the app it films, so one command films from nothing and `reproduce.sh` needs
no stack running first.

```yaml
services:
  - name: api
    run: [npm, --workspace, apps/api, exec, --, tsx, src/main.ts]
    cwd: ../..                      # relative to the storyboard's folder (or --dir)
    env: { PORT: "4431", DATABASE_URL: "${FILM_DATABASE_URL}" }
    ready: http://127.0.0.1:4431/
    before:                         # once, before this service starts
      - [env, "DATABASE_URL=${FILM_DATABASE_URL}", npm, run, db:reset]
```

- **Order.** For each service in order: its `before` commands, then start it, then wait until `ready`
  answers any HTTP response (default `timeout` 120 s). Then `setup`, then the scenes. A service that
  exits while starting fails the run with the end of its log.
- **Never someone else's app.** If a `ready` URL already answers before its service starts, the run
  stops: something else holds that port. `--no-services` films against an app you started yourself
  (and skips `before`).
- **Stopping.** Every service runs in its own process group with no shell. After the run, passed or
  failed, or on Ctrl-C, uat-reel sends the group SIGTERM, then SIGKILL after 5 s.
- **Logs.** Each service's output goes to `services/<name>.log` in the output folder.
- Commands are an executable and its arguments, like `setup`. `env` adds to the inherited environment.

## Reproduce script

Every rehearse and record writes `reproduce.sh` and `storyboard.yaml` into its output folder, so the
take can be rerun from the folder alone, after the storyboard has moved on.

- `storyboard.yaml` is the storyboard source as run: env references unexpanded, so it holds no secret.
- `reproduce.sh` reruns the same command (`record` or `rehearse`, never `--from`: it always reshoots the
  whole film) on that copy, with the options that changed the take (`--base-url`, `--timeout`,
  `--no-post`, `--no-setup`, `--no-services`). Extra arguments pass through, and a later `--out` wins.
- **Folder.** Setup commands, relative URLs and `storageState` resolve against the storyboard's
  folder, recorded relative to the script so a checkout in another place works. `--dir <folder>` sets
  it; `UAT_REEL_DIR` overrides it in the script.
- **Environment.** Every variable the storyboard reads is exported with the value this take used, unless
  the caller has set it. A variable is never written down, and the script stops until it is set, when a
  `secret` step reads it, its name contains `PASSWORD`, `SECRET`, `TOKEN` or `KEY`, or its value holds URL
  credentials (`://user:pass@`). Variables that were unset keep their storyboard fallback.
- **Tool.** The header records the uat-reel version and, for a git checkout, its commit and whether it had
  uncommitted changes, plus the Playwright and ffmpeg versions. The script runs the uat-reel that made
  the take when it is still at the same path, else `npx uat-reel@<version>`; `UAT_REEL` overrides
  both. It warns when the version differs.
- `manifest.reproduce` holds the same facts and the storyboard's SHA-256.

The script reproduces the inputs, not the bytes: app speed, clock times on screen and the app's own
data are outside uat-reel, so `setup` should reset the app. Setup commands also inherit the rest of the
caller's environment (`PATH`, `USER` for a local Postgres login); name anything else they need in the
storyboard so the script records it.

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
