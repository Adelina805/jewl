# jewl — Project

## Goal and audience
Browser jewelry sketchbook for independent makers and hobbyists. Test whether drawing silver around sea glass feels satisfying and helps someone imagine a pendant.

Working tagline: “Your hands. Your eye. Your design.”

Product commitment: no generative AI in the experience — every shape stays directly editable; materials respond predictably to user choices.

## Current scope
First working prototype:
- One pendant canvas with a cool coastal workbench look
- One movable, rotatable sea-glass piece (procedural frosted shard)
- Freehand silver strokes with Weight control
- Edit mode: select, move, and delete individual strokes
- Undo / redo / clear
- Modes keep drawing vs placing glass vs editing strokes unambiguous

Out of scope for now: accounts, payments, manufacturing export, photo import, multi-stone library, AI generation.

## Decisions
- **Stack:** Static HTML / CSS / Canvas 2D — no build step; fast path to drawing feel.
- **Silver:** Tubular stamp brush (lit discs + cool underbelly + thin specular thread). Illustrative metal, not fabrication-accurate.
- **Sea glass:** Irregular closed path with soft frost rim, depth bloom, and a small specular kiss.
- **Interaction:** Silver (draw) · Edit (strokes) · Place (glass + rotate handle). Drawing never moves the glass.
- **History:** Undo/redo snapshots cover stroke create, move, delete, and clear. Glass placement is live and not history-tracked.

## Limitations
- Single procedural glass shape (not photo-based).
- Silver is visual only — not physically accurate or exportable for casting.
- No stylus pressure / tilt yet.
- Strokes render under the glass; no true bezel depth or overlapping metal-over-stone compositing.
- Glass move/rotate is not on the undo stack.

## Latest feedback
None yet — first experiment ready for design review.

## Verification
- Local static server; UI loads; modes switch; glass places and rotates.
- Freehand silver, Weight, Edit (select/move/delete), Undo/Redo/Clear exercised via browser automation.
- Still needs your eye: metallic “feel,” frost softness, and trackpad/stylus drawing comfort on your display.

## Next useful step
Tune materials and stroke feel from your visual feedback, then decide whether a second glass shape or photo-based stone is worth adding.
