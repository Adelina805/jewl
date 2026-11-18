# jewl.io — Sea Glass Sketchbook

## Goal
Explore a browser jewelry sketchbook: place sea glass on a canvas and draw silver around it to imagine a pendant.

## Current scope
First visual prototype only:
- One movable, rotatable sea-glass piece
- Freehand silver drawing with adjustable thickness
- Dimensional metallic stroke appearance
- Undo and clear
- Minimal UI that keeps focus on the piece

Out of scope: fabrication exports, multiple stones, saved collections, accounts.

## Decisions
- **Stack:** Static HTML / CSS / Canvas 2D — no build step; fastest path to drawing feel.
- **Materials:** Procedural sea glass (organic path + frosted fills); silver as overlapping lit discs (tubular stamp brush) plus a fine specular thread.
- **Interaction:** Draw mode by default; Place mode to drag the glass and rotate via a handle. Thickness via a single Weight slider.
- **Look:** Cool coastal atelier — soft blue-gray field, quiet chrome controls, attention on glass and metal.

## Limitations
- Single glass shape (not photo-based or a full collection).
- Silver is illustrative, not physically accurate or exportable for fabrication.
- No pressure sensitivity / stylus tilt yet.
- Strokes sit under the glass; no true bezel depth or casting simulation.

## Verification
- Served locally; UI loads; sea glass renders with frost/highlight.
- Freehand silver, Weight slider, Undo, Clear, and Place (move + rotate handle) exercised in-browser.
- Not fully verified by hand: trackpad/stylus drawing feel, touch on a phone, or metallic look on a calibrated display.

## Next useful step
Tune stroke feel with a real mouse/trackpad (and optionally stylus), then decide whether a second glass shape or a photo-based stone is worth adding.
