# Review log: Hawker Kitchen guest checkout

Storyboard: `examples/demo.storyboard.yaml`. Each round below was done by a fresh general-purpose
subagent using the brief in `skills/uat-reel/reviewers/`.

Only gate 4 was run on this example. It was used to dogfood the tool and the brief while they were
being built. Gates 1–3 apply to real UATs.

## Gate 4: final video, round 1: BLOCK

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | major | The "choose a 12:30 pickup" caption showed while the boxed select still read "Choose a time" | **Tool:** boxes on `fill`/`select`/`check`/`uncheck` now go up after the action, so they frame the result |
| 2 | major | The scene 2 validation error stayed visible during the successful submit | **App:** the error clears on input |
| 3 | major | The error asked for a name that was already filled in | **App:** the message lists only the missing fields; the `expect` now checks the exact text |
| 4 | minor | The "Pickup time" callout covered the error and repeated the field label | **Storyboard:** `box: true` |
| 5 | minor | The cart still showed 2 after the order | **App:** the cart clears on confirmation; a new `expect` proves it |
| 6 | minor | Two chapter cards ran back to back at the start | **Tool:** the title is merged into the scene 1 card |
| 7 | minor | Empty caption band in the tail | **Tool:** the last cue is held through the tail (incomplete, see round 2) |

## Gate 4: final video, round 2: BLOCK (6 of 7 previous findings fixed)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | major | The AC3 proof callout was up for about 1.2s, too short to read | **Tool:** labelled boxes hold for `max(boxHold, reading time of label + note)` |
| 2 | major | The AC2 proof callout was up for about 1.1s | Same fix |
| 3 | minor | Tail still empty: the screencast runs about 1s past the runner's clock | **Tool:** the last cue is stretched to the file duration from ffprobe |
| 4 | minor | The box around the select cut through its label | **Tool:** default `boxPadding` 6→3, `boxWidth` 4→3 |
| 5 | minor | "Place order" labels repeated the button text | **Storyboard:** labels now say what is being tested. **Tool:** new lint warning for labels that repeat a control's name |
| 6 | minor | The opening card was laid out unlike the others | **Tool:** every card leads with "N. Scene title"; card 1's subtitle carries the video title |

## Gate 4: final video, round 3: PASS (6 of 6 previous findings fixed)

These minor findings were left open as tool backlog:

- The AC1 proof box is shorter than the AC2/AC3 proofs because the next chapter follows straight
  away. Idea: a minimum hold for proof (`expect`) boxes.
- The dim layer pulses between consecutive boxes. Idea: keep the dim when the next box starts within
  about 1.5s.
- The "Cart cleared" box ends about 3.5s before the video does. Idea: hold the final box through the
  tail.
- Chapter cards change size to fit their text (Playwright's `showChapter` styling).
- The pickup select was below the caption band while the name was typed. Idea: scroll the form into
  view.
- Frame 0 has no chapter card, so it makes a poor thumbnail.
- The cursor sits on the button label during the AC2 proof. Idea: park the cursor after clicks.
