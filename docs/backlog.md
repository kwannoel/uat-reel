# Backlog

Gaps found by adversarial reviews and by the first trial on a real app (the FoodX B2B shop, a React
SPA with server-side cart and session state). Fixed items are recorded in git history, not here.

## Real-app gaps

- **Teardown hooks.** `setup:` now resets state before a run; nothing yet runs after one.
- **Popover placement.** Callouts sometimes cover a neighbouring proof or the next control: the
  salmon line in the cart, and "Place order" under the payment note. Add a per-step `side:`
  (top/right/bottom/left), or pick a side automatically away from the next step's target.
- **Multi-target proof.** A caption such as "each line starts at its minimum" needs two boxes and two
  expects. Allow `box` on a selector that matches several elements, or a list of targets.
- **Settle after navigation.** A click that navigates in a SPA briefly shows the app's "Loading"
  page. Option: wait for network idle, or for a named element, before ending the step.
- **Popups, new tabs, iframes, uploads, downloads, dialogs** are still unsupported (see the README's
  limitations).

## Polish (from the demo reviews)

- Minimum hold for proof (`expect`) boxes when a chapter card follows straight away.
- Keep the dim layer between boxes less than about 1.5s apart instead of pulsing.
- Hold the final box through the tail.
- Fixed-size chapter cards; a chapter card on frame 0 for thumbnails.
- Scroll forms fully into view before filling.
- Park the cursor off the target after clicks.
