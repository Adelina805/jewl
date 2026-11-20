# jewl — Project

## Goal and audience
Browser jewelry sketchbook for independent makers and hobbyists. Test whether painting sea glass and drawing silver around it feels satisfying and helps someone imagine a pendant.

Working tagline: “Your hands. Your eye. Your design.”

Product commitment: no generative AI in the experience — every shape stays directly editable; materials respond predictably to user choices.

## Current scope
First working prototype:
- One pendant canvas with a cool coastal workbench look
- Paintable sea glass: a Glass tool with a five-color palette (seafoam, teal, cobalt, amber, frosted white)
- Full-window canvas with header and controls floating over it
- Freehand silver strokes with Weight control (each tool keeps its own weight range)
- Move mode: one tool to drag, select and delete any silver or glass stroke
- Undo / redo / clear
- Three modes (Silver · Glass · Move), so painting never accidentally moves anything

Out of scope for now: accounts, payments, manufacturing export, photo import, multi-stone library, AI generation.

## Decisions
- **Stack:** Static HTML / CSS / Canvas 2D — no build step; fast path to drawing feel.
- **Silver:** Liquid / soldered silver. Strokes are summed into a soft metaball field and thresholded, so strokes that touch or come near each other fuse into one mass with rounded fillets (like solder flowing together). The merged silhouette becomes a height map (rounded edge from a jump-flood distance field + dome + slow ripples), normals come from it, and each pixel reflects a procedural studio environment (soft box, dark flags, strip light, dark wall ring) for the chrome look.
- **Silver renderer:** WebGL2 (`silver-gl.js`) does everything on the GPU: capsule masks per weight bucket, gaussian blur (wide blurs at reduced resolution), jump flood, height map, then a final full-device-resolution pass with an analytic anti-aliased edge. Redrawn on every silver stroke change and cached otherwise; it is also reused with a `"glass"` material for the painted sea glass. If WebGL2 or float render targets are missing, `app.js` falls back to the older CPU renderer (same look, slower and lower resolution). `stage.dataset.renderer` reads `webgl` or `cpu`. Tunable via `SILVER.goo` / `SILVER.threshold` in `app.js`.
- **Sea glass:** Painted, not a fixed shard. Glass strokes use the same metaball / jump-flood / height-map pipeline as silver (`SilverGL.create("glass")`, a second WebGL context), but the final pass shades them as frosted translucent glass: a tint that deepens with thickness, a lighter frosted rim, broad matte highlights, grain, and a gently wobbling edge so pieces read as tumbled. Strokes are grouped by palette color; each group fuses on its own, is rendered in one GPU pass, and is composited into a cached glass layer (`glassLayer` in `app.js`). Groups stack in the order they were first painted. Tunable via `GLASS` in `app.js`.
- **Layering:** workbench, then glass, then silver, so silver sits over the stone and the glass shows through gaps. Silver is hit-tested before glass in Move.
- **Workbench:** Slightly brighter studio field + upper-left key pool so metal has luminous surroundings to “reflect.”
- **Interaction:** Silver · Glass · Move. In Move, pick order is silver stroke, then glass stroke, so thin silver stays grabbable over glass. Clicking empty canvas deselects. The color swatches only show in Glass mode. Shortcuts: `D`/`S` Silver, `G` Glass, `M` (also `E`/`P`) Move, ⌫ deletes the selected stroke.
- **Layout:** The canvas is fixed to the full viewport; the header and footer are pointer-transparent except for their controls, so you can draw under them.
- **History:** Undo/redo snapshots cover stroke create (silver and glass, with color), move, delete, and clear.

## Limitations
- Glass is a procedural height-field render, not photo-based or physically refractive: it doesn't bend the background.
- Silver is a procedural height-field render, not a true 3D/PBR model — no real HDRI, no inter-reflection with the stone, not fabrication-accurate or exportable for casting.
- Strokes fuse visually only; each stroke is still a separate object for Move/Delete, so moving one pulls it out of the blob.
- The GPU field is capped at ~3.8M texels and 1.5 texels per CSS px, so very large canvases get a slightly coarser height/shadow field (the silhouette edge stays pixel-sharp).
- Thin strokes on the bright bench need the dark underbelly/contact shadow to stay readable; very fine Weight can still look soft.
- No stylus pressure / tilt yet.
- Silver draws flat over glass: no true bezel depth, no reflection of the stone in the metal.
- Glass of different colors does not blend: overlapping groups just composite translucently, and only same-color strokes fuse.
- If WebGL2 is unavailable, glass falls back to flat translucent strokes (no frosting or shading).
- Moving or deleting works per stroke, so a fused glass piece made of several strokes has to be moved stroke by stroke.
- Overlapping strokes are grabbed topmost-first; silver is picked before glass.
- Each color group is its own GPU pass, so a canvas with many colors repaints a little slower while painting.

## Latest feedback
Silver looked like soft tubular gray / plastic, not polished sterling. References show high dynamic range (near-white highlights + charcoal recesses), bright bezel rims, and environment-driven contrast rather than muddy mid-gray.

## Verification
- Local static server; UI loads; Silver / Move modes switch; undo / redo exercised.
- Paintable glass checked in the browser (839×672 viewport) with synthetic pointer events and canvas pixel sampling: all five colors paint, same-color strokes fuse, different colors composite translucently, silver draws over glass, and Move (old spot cleared, new spot inked), select, Delete, Undo, Redo and Clear all work on glass strokes.
- Not yet checked with a real mouse or trackpad: grab/grabbing cursor feel and handle hit comfort. The checks above used synthetic pointer events.
- Freehand silver redrawn after material change; pixel sampling on metal regions ~avg L 180–190 with bright speculars (~60%) and visible dark bands (~10%).
- Still worth your eye on a real display: frost amount and edge wobble of the glass; whether the metal feels “sterling” next to your reference photos, and trackpad/stylus drawing comfort.

## Next useful step
Look at the painted glass on a real display: frost amount, translucency and edge wobble are the knobs (`GLASS` in `app.js`, the glass shading block in `silver-gl.js`). Then decide whether to add a true bezel over the glass or a way to group several strokes so they move together.
