# jewl — Project

## Goal and audience
Browser jewelry sketchbook for independent makers and hobbyists. Test whether painting sea glass and drawing silver around it feels satisfying and helps someone imagine a pendant.

Working tagline: “Your hands. Your eye. Your design.”

Product commitment: no generative AI in the experience — every shape stays directly editable; materials respond predictably to user choices.

## Current scope
First working prototype:
- One pendant canvas with a cool coastal workbench look
- Compact bottom dock: Draw · Select · Eraser | Metal · Glass · Size
- Paintable sea glass via Glass material presets (seafoam, teal, cobalt, amber, frosted white)
- Metal material with presets (Silver, Gold, Rose gold, Dark gray, Black) plus a custom HSV color; each tint shades the chrome, and same-color strokes fuse like glass
- Full-window canvas with header and dock floating over it
- Freehand Draw strokes; one shared Size slider (4 to 90) for Draw and Eraser, kept when switching tools
- Select: drag, select, and delete any silver or glass stroke
- Eraser: circular brush (Size diameter) that deletes only geometry inside the circle, splitting strokes when cut
- Undo / redo / clear (header)

Out of scope for now: accounts, payments, manufacturing export / Download, photo import, multi-stone library, AI generation, straight-line tool (planned as straight strokes, not a measure tool).

## Decisions
- **Stack:** Static HTML / CSS / Canvas 2D — no build step; fast path to drawing feel.
- **Silver / metal:** Liquid / soldered metal. Strokes are summed into a soft metaball field and thresholded, so strokes that touch or come near each other fuse into one mass with rounded fillets (like solder flowing together). The merged silhouette becomes a height map (rounded edge from a jump-flood distance field + dome + slow ripples), normals come from it, and each pixel reflects a procedural studio environment (soft box, dark flags, strip light, dark wall ring) for the chrome look. Metal strokes store a preset id or custom hex in `color` and are grouped by color (same-color fuses; different metals composite). The final chrome pass tints recesses with the preset’s deep tone and highlights with its light tone.
- **Silver renderer:** WebGL2 (`silver-gl.js`) does everything on the GPU: capsule masks per weight bucket, gaussian blur (wide blurs at reduced resolution), jump flood, height map, then a final full-device-resolution pass with an analytic anti-aliased edge. Redrawn on every silver stroke change and cached otherwise; it is also reused with a `"glass"` material for the painted sea glass. If WebGL2 or float render targets are missing, `app.js` falls back to the older CPU renderer (same look, slower and lower resolution). `stage.dataset.renderer` reads `webgl` or `cpu`. Tunable via `SILVER.goo` / `SILVER.threshold` in `app.js`.
- **Sea glass:** Painted, not a fixed shard. Glass strokes use the same metaball / jump-flood / height-map pipeline as silver (`SilverGL.create("glass")`, a second WebGL context), but the final pass shades them as frosted translucent glass: a tint that deepens with thickness, a lighter frosted rim, broad matte highlights, grain, and a gently wobbling edge so pieces read as tumbled. Strokes are grouped by palette color; each group fuses on its own, is rendered in one GPU pass (cached per color so unchanged groups are skipped), and is composited into a cached glass layer (`glassLayer` in `app.js`). Live drawing may drop resolution via `maxArea`; settled frames restore full quality. Groups stack in the order they were first painted. Tunable via `GLASS` in `app.js`.
- **Layering:** workbench, then glass, then silver, so silver sits over the stone and the glass shows through gaps. Silver is hit-tested before glass in Move.
- **Flush plane:** glass and silver read as one level on the bench. The glass dome is nearly flat (`GLASS.domeK` 0.4); see the molding notes below for how metal meets glass.
- **Liquid metal molds to glass:** the glass is a solid obstacle for the silver; the glass never changes shape. `app.js` keeps a second canvas, `glassLayer.dist`, with the signed distance to the glass edge (R = fine, +-16 CSS px; G = coarse, +-64 CSS px; written by `glassGL.renderDist()`, jump-flood distance deep inside, merged across colors with `lighten`). It and the glass color layer are uploaded as textures into the silver context when silver needs them (distance is skipped until silver exists; live glass paint defers remolding until the gesture settles). In the silver pipeline, after the metaball fields are summed:
  - *Mold* (`MOLD_GATHER_FS`, `MOLD_COMBINE_FS`): metal may only overlap the glass by a small lip; metal drawn inside the glass is collected along the inward normal (up to 60 px, each bit assigned to its nearest edge), deposited in a band just outside the edge, spread along the edge with a blur, and added back, so it piles up against the stone like displaced liquid. Metal touching the edge also wets along it.
  - *Level*: the jump flood treats glass as solid, so metal keeps full height up to the contact instead of rolling down; the dome is computed from metal + glass together, so there is no slope toward the stone; and near glass the metal's bench-side bevel narrows (flatter, bezel-like). Away from glass the silver is unchanged.
  - *Final shading*: opaque chrome with a narrow bevel and a thin dark seam at the contact, and only a hint of glass color within ~2 px of it. On the glass side, the frosted rounded edge right next to the metal is painted over with the glass color from further inside, so stone and metal read as one level. Silver drop shadow never falls on glass.
  - Silver strokes lying entirely inside a glass piece (checked against a 1/4-res CPU readback of the distance layer) are not molded: they render in a separate pass on top. Both passes go into a cached `metal.layer` canvas.
  - Tunable via `WRAP` in `app.js` (`lipOverlap`, `bandWidth`, `displace`, `wet`, `bevel`, `tintBleed`, `seam`, `flattenGlass`, `flattenWidth`). Skipped on the CPU fallback and when glass uses the simple fallback.
- **Workbench:** Slightly brighter studio field + upper-left key pool so metal has luminous surroundings to “reflect.”
- **Interaction:** Tools (Draw · Select · Eraser) are separate from materials (Metal · Glass). Draw paints with the active material; Select picks silver first then glass so thin silver stays grabbable; Eraser punches a Size-diameter circle through stroke geometry, splitting or trimming rather than deleting whole strokes (one undo entry per gesture). Clicking a Metal or Glass main control activates Draw with that material’s last-used preset; its chevron opens a compact scrolling preset library above the control (one library at a time; closes on select, outside click, or Escape). Selecting a preset activates that material immediately. The rainbow “Custom” swatch on Metal and Glass opens an in-app HSV picker (saturation/value pad + hue strip) instead of the system `input[type=color]`, so it works on mobile browsers; glass and metal custom hexes tint their respective renders. Size stays visible in the dock for all tools. Shortcuts: `D` Draw, `S`/`M` Select, `E` Eraser, `G` Glass+Draw, ⌫ deletes the selected stroke in Select, ⌘/Ctrl+C copies, ⌘/Ctrl+V pastes (16 px offset; switches to Select), ⌘/Ctrl+D duplicates the selection, Escape closes a library or deselects.
- **Layout:** The canvas is fixed to the full viewport; the header and a centered bottom dock are pointer-transparent except for their controls, so you can draw under them. Undo / Redo / Clear stay in the header.
- **History:** Undo/redo snapshots cover stroke create (silver and glass, with color), move, delete, paste, duplicate, and clear.

## Limitations
- Glass is a procedural height-field render, not photo-based or physically refractive: it doesn't bend the background.
- Silver is a procedural height-field render, not a true 3D/PBR model — no real HDRI, only an approximate tint reflected from nearby glass (no true inter-reflection), not fabrication-accurate or exportable for casting.
- Strokes fuse visually only; each stroke is still a separate object for Move/Delete, so moving one pulls it out of the blob.
- The GPU field is capped at ~3.8M texels and 1.5 texels per CSS px, so very large canvases get a slightly coarser height/shadow field (the silhouette edge stays pixel-sharp).
- Thin strokes on the bright bench need the dark underbelly/contact shadow to stay readable; very fine Size can still look soft.
- The shared Size range (4 to 90) means silver can be set very thick, and fine silver widths take a little more precision on the slider.
- Different metal colors do not fuse: overlapping groups composite like glass; only same-color metal strokes melt together.
- No stylus pressure / tilt yet.
- Molding is a 2D field effect, not a fluid simulation: displaced metal is roughly (not exactly) conserved, and metal drawn more than ~60 px inside a glass piece (in a stroke that also crosses its edge) is lost rather than pushed out.
- Silver strokes that sit entirely inside glass (on top) and molded strokes render in separate passes, so they do not fuse with each other. A stroke switches between the two as soon as any part of it reaches the glass edge.
- Glass with no silver touching it gets no rim; there is no automatic bezel.
- The glass-edge flattening next to metal assumes a light bench color behind the glass.
- Glass edge distance is 8-bit (fine +-16 px, coarse +-64 px) and only computed within each glass group's render rect.
- Live glass painting defers silver remolding until the stroke (or move) settles, and may run the glass GPU pass at a lower resolution (`SILVER.liveArea`); the settled frame remolds and restores full quality. Distance for molding is skipped while there is no silver, then built on demand.
- Glass of different colors does not blend: overlapping groups just composite translucently, and only same-color strokes fuse.
- If WebGL2 is unavailable, glass falls back to flat translucent strokes (no frosting or shading).
- Moving or deleting works per stroke, so a fused glass piece made of several strokes has to be moved stroke by stroke.
- Overlapping strokes are grabbed topmost-first; silver is picked before glass.
- Each color group is its own GPU pass and is cached; only groups whose strokes changed re-render while painting.

## Latest feedback
Silver looked like soft tubular gray / plastic, not polished sterling. References show high dynamic range (near-white highlights + charcoal recesses), bright bezel rims, and environment-driven contrast rather than muddy mid-gray.

## Verification
- Local static server; UI loads; Draw / Select / Eraser and Metal / Glass dock controls switch; undo / redo exercised.
- Molding checked in the browser (853×672 viewport, synthetic pointer events, no console errors): a ring drawn over a teal pebble's edge ends up as a bezel hugging the edge; a stroke across a cobalt pebble splits and piles up at both crossings; a stroke just below an amber pebble wets up onto its edge; a thick C stroke half over a seafoam pebble molds into a C bezel; a squiggle inside a frosted piece sits on top. Pixel rows across the contacts show neutral, opaque chrome (no glass cast), a dark seam, then glass. Moving a stroke onto/off glass re-molds it; Delete, Undo and Redo re-render correctly, and undoing back to the start reproduces the original frame exactly. Not checked on a real display or with the CPU fallback.
- Paintable glass checked in the browser (839×672 viewport) with synthetic pointer events and canvas pixel sampling: all five colors paint, same-color strokes fuse, different colors composite translucently, silver draws over glass, and Move (old spot cleared, new spot inked), select, Delete, Undo, Redo and Clear all work on glass strokes.
- Not yet checked with a real mouse or trackpad: grab/grabbing cursor feel and handle hit comfort. The checks above used synthetic pointer events.
- Freehand silver redrawn after material change; pixel sampling on metal regions ~avg L 180–190 with bright speculars (~60%) and visible dark bands (~10%).
- Still worth your eye on a real display: frost amount and edge wobble of the glass; whether the metal feels “sterling” next to your reference photos, and trackpad/stylus drawing comfort.

## Next useful step
Look at the molding on a real display next to your sea glass jewelry photos and tune `WRAP` (lip, band width, displace, wet, bevel, seam, glass flattening) and `GLASS` (frost, translucency, edge wobble). Then decide whether to add an automatic bezel around glass pieces or a way to group several strokes so they move together.
