---
name: uat-reel
description: Produce a UAT (user acceptance test) video of a web app with uat-reel (Playwright + driver.js). The video has red-box highlights, burned-in captions and assertions, and an independent adversarial review after each stage. Use when asked to film, record or demo a feature for UAT sign-off, make a walkthrough video with highlights or subtitles, or re-record an existing *.storyboard.yaml.
---

# uat-reel: storyboarded UAT videos

You produce a video a stakeholder can sign off from without anyone in the room. The video is scripted
from a storyboard, so it can be re-recorded every release. It **fails if the app misbehaves**, because
`expect` steps are assertions. It has been **attacked by independent reviewers** at every stage.

The work runs in four stages, with a review gate after each:

```
1 Storyboard ─▶ gate ─▶ 2 Subtitles ─▶ gate ─▶ 3 Highlights ─▶ gate ─▶ 4 Record ─▶ final video gate ─▶ deliver
```

Do the stages in order. Don't add captions while the storyboard is still changing, and don't add boxes
before the captions pass. Each gate is cheaper than re-recording.

## 0. Before you start

Collect these, and ask the user for any you cannot find in the repo:

- **Feature and audience.** Who signs off (product owner, client, QA lead)? Write for them.
- **Acceptance criteria.** Take them from the ticket, PRD or user. Do not invent criteria. If none
  exist, draft them and get the user's confirmation before stage 1.
- **Where it runs.** A local dev server or a staging URL. Never record against production unless the
  user says so explicitly.
- **Sign-in.** Use test accounts from the project's seed or fixture files. Either sign in through the
  UI with `value: ${UAT_PASSWORD}` and `secret: true`, which only works on a password field, or point
  `storageState:` at a saved session. Never type real personal credentials. Never put a secret in the
  storyboard; use `${ENV}` references for credentials and for anything that differs between
  environments (`baseUrl: ${UAT_BASE_URL}`).
- **People and apps.** If the flow crosses people or apps (a buyer and a supplier, a shop and a back
  office), give each its own `actors:` entry and set `actor:` on every scene. Steps another person takes
  that the video only mentions go in an `offCamera: true` scene. Use `capture` + `{{name}}` to follow
  the same record (an order number) across actors instead of picking "the first row".
- **Starting the app.** Declare the servers the film needs under `services:` (command, `ready` URL,
  `before` commands such as creating the database), on ports nothing else uses. Then one command films
  from nothing, and `reproduce.sh` reshoots without anyone starting the app first.
- **Resetting state.** Put the commands that reset the app's data under `setup:`, so every rehearse and
  record starts from the same state and `record --from <scene>` can reshoot one scene. A `--from`
  reshoot joins footage from two runs of the app, so if the app shows times or generated ids, record
  the whole film for the final take instead.
- **Tooling.** Node 20+, `ffmpeg` with libass (`ffmpeg -filters | grep subtitles`), and then:
  ```bash
  npm i -D uat-reel && npx playwright install chromium
  ```

Files live together:

```
uat/<slug>.storyboard.yaml   the script (commit it)
uat/<slug>.reviews.md        review log: every gate, round, verdict and fix (commit it)
out/<slug>/                  record output (video.mp4, captions, review/), usually gitignored
out/<slug>-rehearse/         rehearse output (shots/)
```

Run `npx uat-reel schema` for the full storyboard format, or `npx uat-reel init uat/<slug>.storyboard.yaml`
for a starter.

## 1. Storyboard

Write `title`, `description`, `acceptance`, and scenes containing **actions and `expect`s only**.
Leave out `say` and `box` at this stage.

- One scene per acceptance criterion, plus a scene for each negative path the criteria imply (invalid
  input, permission denied, empty state). Set `covers: [AC…]` on each.
- Every covering scene ends with an `expect` that would **fail if the criterion were broken**. Check
  specific text (`text: "Pickup at 12:30"`), not just that a container is visible.
- Do what a real user does: navigate through the UI. Don't deep-link past the flow under test.
- Selectors: `role=button[name="…"]`, `role=textbox[name="…"]`, `text=…`, `[data-testid=…]`. Avoid
  CSS chains, `nth-child` and generated class names. Lint warns about these.
- Use believable but fake data (`meiling@example.com`, not a real person).

Iterate until both of these are clean:

```bash
npx uat-reel lint uat/<slug>.storyboard.yaml
npx uat-reel rehearse uat/<slug>.storyboard.yaml   # no video, screenshots in out/<slug>-rehearse/shots
```

**Gate 1:** storyboard review, using `reviewers/storyboard.md`. Pass it the storyboard, the acceptance
criteria, and the rehearse `shots/` and `manifest.json`.

## 2. Subtitles

Add a `say:` to each step a viewer needs explained. A caption runs from its step until the next `say`
or the end of the scene. **The video waits until each caption has been readable for
`max(minMs, chars / cps)`**, so captions set the pacing and you don't add `wait`s for reading.

- Describe what the user is doing and why, in present tense, from the user's side: "The guest adds a
  bowl of laksa." Not "Click the button".
- Keep it within 2 lines of about 42 characters, ideally 14 words or fewer. Lint enforces the line
  budget.
- No selectors, no jargon, no claims the video doesn't show. If the backend isn't visible, don't say
  "payment is captured".
- The caption on each proving `expect` states the outcome in the criterion's own terms.
- Use the same name for the persona and the same tense throughout.

Run `lint` again. **Gate 2:** caption review, using `reviewers/captions.md`. Pass it the storyboard,
the acceptance criteria and the `lint` output.

## 3. Highlights (red boxes)

Add `box:` where the viewer must look:

- **Every proving `expect` gets a box.** That is the evidence frame.
- Add a box to the control for each important action. Not every step needs one: boxing everything
  means nothing stands out.
- `box: true` when the control labels itself (a button that says "Checkout"). A string label (4 words
  or fewer) only when it adds information the screen doesn't show. Never repeat the button's own text.
- `note:` gives one sentence of why ("Lists both dishes and the pickup time"). Use it mainly on proof
  boxes.
- Use `highlight: <selector>` to point at something without acting on it.
- Tune look and pacing under `style:` (`boxColor`, `dim`, `boxPadding`) and `pacing:` (`boxHold`).

Run `rehearse` again. Its `shots/` show each box exactly as it will be recorded.
**Gate 3:** highlight review, using `reviewers/highlights.md`. Pass it the rehearse `shots/`,
`manifest.json` and the storyboard.

## 4. Record

```bash
npx uat-reel record uat/<slug>.storyboard.yaml
```

This produces:

- `video.mp4`: captions burned into a band under the page;
- `video.clean.mp4`: soft subtitles that viewers can toggle;
- `captions.srt` and `captions.vtt`;
- `manifest.json`;
- `review/`: stills, contact sheets and `REVIEW.md`, which lists for every still the caption and box
  that should be visible.

If the command exits 1, an `expect` failed or an action broke, and `failure.png` shows the state.
**That is a UAT finding about the app, not a tooling problem.** Report it to the user. Don't "fix" the
storyboard to make it pass unless the storyboard itself was wrong.

**Gate 4:** final video review, using `reviewers/video.md`. Pass it the `review/` folder (start at
`review/REVIEW.md`), `manifest.json` and the acceptance criteria. You cannot watch the video, and the
reviewer can't either. The review pack is how it gets reviewed. Open the stills.

## Adversarial review protocol (every gate)

1. **Spawn a fresh reviewer.** Start a new subagent (for example a general-purpose agent) with no
   memory of your work. Its prompt is the brief from `reviewers/<gate>.md` (read the file and paste it
   in), followed by:
   - absolute paths to the artifacts listed for that gate;
   - the acceptance criteria, verbatim;
   - on round 2 or later only: the previous round's findings, so it can verify each fix. It still
     reviews everything from scratch.

   Do **not** include your reasoning, your opinion of the work, or what you expect it to find. A
   reviewer told the work is good will agree.
2. **The reviewer returns** a `VERDICT: PASS` or `VERDICT: BLOCK` line and a findings list. Each
   finding has a severity (`blocker`, `major` or `minor`), a location, evidence and a fix.
3. **You resolve the findings.** Fix every blocker and major. If you reject a finding, write down why
   in the log. Rejecting a blocker needs evidence, not preference. Minors are optional.
4. **Re-run** whatever the gate depends on (`lint`, `rehearse`, `record`), then go back to step 1 with
   a **new** reviewer. Never ask the same reviewer to re-check, because it anchors on what it said
   before.
5. **Stop after 3 rounds** of a gate without a PASS. Show the user the outstanding findings and ask
   how to proceed.
6. **Log everything** in `uat/<slug>.reviews.md`: gate, round, verdict, findings, and what you changed
   or why you rejected each one.

You never issue a PASS yourself. If you cannot spawn subagents, do the review with the brief as a
separate, explicit pass. Label it **self-review (not independent)** in the log and tell the user.

## 5. Deliver

Report to the user:

- the paths to `video.mp4`, `video.clean.mp4`, the captions and `REVIEW.md`;
- `reproduce.sh` from the output folder, which reshoots the film, and the secrets it needs set. Ship it
  with the film wherever the film goes;
- each acceptance criterion with its scene and the timestamp of its proof frame (from `REVIEW.md`);
- the gate verdicts and the rounds each one took (link `uat/<slug>.reviews.md`);
- anything a reviewer raised that you didn't fix, and why;
- any app bugs the recording uncovered.

When the UI changes later, re-run `rehearse`, fix the storyboard, and re-record. Gates 1–3 only need
to re-run for the scenes that changed. Gate 4 always re-runs.
