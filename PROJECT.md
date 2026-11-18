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
- **Silver:** Layered Canvas 2D “polished sterling” stroke (not a 3D PBR shader). Aimed at the attached reference look: bright cool body, charcoal env/AO recesses, sharp white specular thread + Fresnel rim, warm bench bounce, ping glints on curves. Stroke-led layers (not dense lit discs) so dark reflection bands aren’t stamped out.
- **Sea glass:** Irregular closed path with soft frost rim, depth bloom, and a small specular kiss.
- **Workbench:** Slightly brighter studio field + upper-left key pool so metal has luminous surroundings to “reflect.”
- **Interaction:** Silver (draw) · Edit (strokes) · Place (glass + rotate handle). Drawing never moves the glass.
- **History:** Undo/redo snapshots cover stroke create, move, delete, and clear. Glass placement is live and not history-tracked.

## Limitations
- Single procedural glass shape (not photo-based).
- Silver is illustrative 2D metal — no real HDRI/environment map, no inter-reflection with the stone, not fabrication-accurate or exportable for casting.
- Thin strokes on the bright bench need the dark underbelly/contact shadow to stay readable; very fine Weight can still look soft.
- No stylus pressure / tilt yet.
- Strokes render under the glass; no true bezel depth or overlapping metal-over-stone compositing.
- Glass move/rotate is not on the undo stack.

## Latest feedback
Silver looked like soft tubular gray / plastic, not polished sterling. References show high dynamic range (near-white highlights + charcoal recesses), bright bezel rims, and environment-driven contrast rather than muddy mid-gray.

## Verification
- Local static server; UI loads; Silver / Edit / Place modes switch; undo / redo exercised.
- Freehand silver redrawn after material change; pixel sampling on metal regions ~avg L 180–190 with bright speculars (~60%) and visible dark bands (~10%).
- Still worth your eye on a real display: whether the metal feels “sterling” next to your reference photos, and trackpad/stylus drawing comfort.

## Next useful step
Decide whether the sterling read is good enough to keep, or if a second pass (subtle hammered normal / true bezel over glass) is worth it before adding another glass shape.
