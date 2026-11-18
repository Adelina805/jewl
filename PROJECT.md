# jewl — Project

## Goal and audience
Browser jewelry sketchbook for independent makers and hobbyists. Test whether drawing silver around sea glass feels satisfying and helps someone imagine a pendant.

Working tagline: “Your hands. Your eye. Your design.”

Product commitment: no generative AI in the experience — every shape stays directly editable; materials respond predictably to user choices.

## Current scope
First working prototype:
- One pendant canvas with a cool coastal workbench look
- One movable, rotatable sea-glass piece (procedural frosted shard)
- Full-window canvas with header and controls floating over it
- Freehand silver strokes with Weight control
- Move mode: one tool to drag any silver stroke or the glass, rotate the glass via its handle, and select/delete strokes
- Undo / redo / clear
- Two modes only (Silver · Move), so drawing never accidentally moves anything

Out of scope for now: accounts, payments, manufacturing export, photo import, multi-stone library, AI generation.

## Decisions
- **Stack:** Static HTML / CSS / Canvas 2D — no build step; fast path to drawing feel.
- **Silver:** Liquid / soldered silver. Strokes are summed into a soft metaball field and thresholded, so strokes that touch or come near each other fuse into one mass with rounded fillets (like solder flowing together). The merged silhouette becomes a height map (rounded edge from a jump-flood distance field + dome + slow ripples), normals come from it, and each pixel reflects a procedural studio environment (soft box, dark flags, strip light, dark wall ring) for the chrome look.
- **Silver renderer:** WebGL2 (`silver-gl.js`) does everything on the GPU: capsule masks per weight bucket, gaussian blur (wide blurs at reduced resolution), jump flood, height map, then a final full-device-resolution pass with an analytic anti-aliased edge. Redrawn on every stroke change, cached for glass moves/rotation. If WebGL2 or float render targets are missing, `app.js` falls back to the older CPU renderer (same look, slower and lower resolution). `stage.dataset.renderer` reads `webgl` or `cpu`. Tunable via `SILVER.goo` / `SILVER.threshold` in `app.js`.
- **Sea glass:** Irregular closed path with soft frost rim, depth bloom, and a small specular kiss.
- **Workbench:** Slightly brighter studio field + upper-left key pool so metal has luminous surroundings to “reflect.”
- **Interaction:** Silver (draw) · Move (everything else). Edit and Place were merged. In Move, pick order is rotate handle → silver stroke → glass, so thin strokes stay grabbable next to or over the glass. Clicking empty canvas deselects. Shortcuts: `D`/`S` Silver, `M` (also `E`/`P`) Move, ⌫ deletes the selected stroke.
- **Layout:** The canvas is fixed to the full viewport; the header and footer are pointer-transparent except for their controls, so you can draw under them.
- **History:** Undo/redo snapshots cover stroke create, move, delete, and clear. Glass placement is live and not history-tracked.

## Limitations
- Single procedural glass shape (not photo-based).
- Silver is a procedural height-field render, not a true 3D/PBR model — no real HDRI, no inter-reflection with the stone, not fabrication-accurate or exportable for casting.
- Strokes fuse visually only; each stroke is still a separate object for Move/Delete, so moving one pulls it out of the blob.
- The GPU field is capped at ~3.8M texels and 1.5 texels per CSS px, so very large canvases get a slightly coarser height/shadow field (the silhouette edge stays pixel-sharp).
- Thin strokes on the bright bench need the dark underbelly/contact shadow to stay readable; very fine Weight can still look soft.
- No stylus pressure / tilt yet.
- Strokes render under the glass; no true bezel depth or overlapping metal-over-stone compositing.
- Glass move/rotate is not on the undo stack (stroke moves, deletes, and clear are).
- Only silver strokes can be selected/deleted; the glass can be moved and rotated but not deleted.
- The glass and its rotate handle are always shown in Move mode, and the glass stays at a fixed size, so it can look small on very large displays.
- Overlapping silver is grabbed topmost-first; a stroke running through the glass can be picked over the glass at that line.

## Latest feedback
Silver looked like soft tubular gray / plastic, not polished sterling. References show high dynamic range (near-white highlights + charcoal recesses), bright bezel rims, and environment-driven contrast rather than muddy mid-gray.

## Verification
- Local static server; UI loads; Silver / Move modes switch; undo / redo exercised.
- Move mode, checked by canvas pixel sampling on a fresh tab (783×772 viewport): dragged a stroke (old spot cleared, new spot inked), rotated the glass via the handle (glass stayed centered), dragged the glass (old spot cleared, new spot teal), selected a stroke (Delete enabled), deleted it, undid the delete (stroke restored), and clicked empty space (deselected).
- Not yet checked with a real mouse or trackpad: grab/grabbing cursor feel and handle hit comfort. The checks above used synthetic pointer events.
- Freehand silver redrawn after material change; pixel sampling on metal regions ~avg L 180–190 with bright speculars (~60%) and visible dark bands (~10%).
- Still worth your eye on a real display: whether the metal feels “sterling” next to your reference photos, and trackpad/stylus drawing comfort.

## Next useful step
Decide whether the sterling read is good enough to keep, or if a second pass (subtle hammered normal / true bezel over glass) is worth it before adding another glass shape.
