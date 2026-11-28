(() => {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = document.querySelector(".stage");
  const thicknessInput = document.getElementById("thickness");
  const thicknessValue = document.getElementById("thickness-value");
  const sizeBtn = document.getElementById("size-btn");
  const sizeBtnDot = document.getElementById("size-btn-dot");
  const sizeBtnLabel = document.getElementById("size-btn-label");
  const sizePanel = document.getElementById("size-panel");
  const sizePresetsEl = document.getElementById("size-presets");
  const undoBtn = document.getElementById("undo");
  const redoBtn = document.getElementById("redo");
  const deleteBtn = document.getElementById("delete");
  const duplicateBtn = document.getElementById("duplicate");
  const clearBtn = document.getElementById("clear");
  const downloadBtn = document.getElementById("download");
  const dock = document.querySelector(".dock");
  const drawBtn = document.getElementById("tool-draw");
  const selectBtn = document.getElementById("tool-select");
  const eraseBtn = document.getElementById("tool-erase");
  const metalSplit = document.getElementById("metal-split");
  const glassSplit = document.getElementById("glass-split");
  const metalMain = document.getElementById("metal-main");
  const glassMain = document.getElementById("glass-main");
  const metalChevron = document.getElementById("metal-chevron");
  const glassChevron = document.getElementById("glass-chevron");
  const metalLibrary = document.getElementById("metal-library");
  const glassLibrary = document.getElementById("glass-library");
  const metalSwatch = document.getElementById("metal-swatch");
  const glassSwatch = document.getElementById("glass-swatch");
  const eraseCursorEl = document.getElementById("erase-cursor");

  const SIZE_MIN = 4;
  const SIZE_MAX = 100;
  /** Dot diameters (CSS) for the four presets, small → large. */
  const SIZE_PRESET_DOTS = ["0.28rem", "0.42rem", "0.58rem", "0.78rem"];
  const SIZE_PRESETS = [5, 10, 20, 40];

  /** @typedef {{x:number,y:number}} Pt */
  /** @typedef {{id:number, kind: "silver"|"glass", color: string, points: Pt[], width: number}} Stroke */

  // Metal palette. Tints shade the chrome (light = highlight, deep = recess).
  // Library grid (3 cols) order: gold, rose gold, custom / silver, dark gray, black.
  const METAL_PRESETS = [
    { id: "gold", name: "Gold", light: "#fff6d8", deep: "#b8892a" },
    { id: "rose", name: "Rose gold", light: "#ffe8e2", deep: "#b57666" },
    { id: "silver", name: "Silver", light: "#f4f6f8", deep: "#7a8794" },
    { id: "dark-gray", name: "Dark gray", light: "#8a8e96", deep: "#3a3e46" },
    { id: "black", name: "Black", light: "#4a4a4e", deep: "#0a0a0c" },
  ];
  const DEFAULT_METAL_PRESET = "silver";

  // Sea-glass palette. Tints are sRGB; "light" is the thin/frosted tone, "deep" the thick body.
  // Library grid (3 cols) order: green, amber, custom / pale blue, white, deep blue.
  const GLASS_COLORS = [
    { id: "deep-green", name: "Deep green", light: "#5aaa72", deep: "#0f4a28" },
    { id: "amber", name: "Amber", light: "#c99858", deep: "#5c3010" },
    { id: "pale-blue", name: "Pale blue", light: "#c5ebe8", deep: "#4fa8a8" },
    { id: "white", name: "White", light: "#f6f8f8", deep: "#c2ced2" },
    { id: "deep-blue", name: "Deep blue", light: "#4a78c8", deep: "#122f78" },
  ];
  const DEFAULT_GLASS_COLOR = "pale-blue";
  const hexToRgb = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
  const rgbToHex = (r, g, b) => {
    const to = (x) =>
      Math.max(0, Math.min(255, Math.round(x * 255)))
        .toString(16)
        .padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  };
  /** Derive frosted light/deep pair from a single picked hex (deep ≈ color, light toward white). */
  function tintPairFromHex(hex) {
    const deepRgb = hexToRgb(hex);
    const lightRgb = deepRgb.map((c) => c + (1 - c) * 0.58);
    return {
      id: hex,
      name: "Custom",
      light: rgbToHex(lightRgb[0], lightRgb[1], lightRgb[2]),
      deep: hex,
      lightRgb,
      deepRgb,
    };
  }
  const isCustomHex = (id) => typeof id === "string" && /^#[0-9a-fA-F]{6}$/.test(id);

  function hexToHsv(hex) {
    const [r, g, b] = hexToRgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: max === 0 ? 0 : d / max, v: max };
  }

  function hsvToHex(h, s, v) {
    const hh = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hh < 60) [r, g, b] = [c, x, 0];
    else if (hh < 120) [r, g, b] = [x, c, 0];
    else if (hh < 180) [r, g, b] = [0, c, x];
    else if (hh < 240) [r, g, b] = [0, x, c];
    else if (hh < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return rgbToHex(r + m, g + m, b + m);
  }

  for (const c of GLASS_COLORS) {
    c.lightRgb = hexToRgb(c.light);
    c.deepRgb = hexToRgb(c.deep);
  }
  for (const c of METAL_PRESETS) {
    c.lightRgb = hexToRgb(c.light);
    c.deepRgb = hexToRgb(c.deep);
  }
  const glassColorById = (id) => {
    if (isCustomHex(id)) return tintPairFromHex(id.toLowerCase());
    return (
      GLASS_COLORS.find((c) => c.id === id) ||
      GLASS_COLORS.find((c) => c.id === DEFAULT_GLASS_COLOR)
    );
  };
  const metalPresetById = (id) => {
    if (isCustomHex(id)) {
      const pair = tintPairFromHex(id.toLowerCase());
      return {
        id: pair.id,
        name: "Custom",
        light: pair.light,
        deep: pair.deep,
        lightRgb: pair.lightRgb,
        deepRgb: pair.deepRgb,
      };
    }
    return (
      METAL_PRESETS.find((c) => c.id === id) ||
      METAL_PRESETS.find((c) => c.id === DEFAULT_METAL_PRESET)
    );
  };
  let glassColor = DEFAULT_GLASS_COLOR;
  /** Last custom hex; strokes store the hex directly in `color`. */
  let customGlassHex = "#c45a7a";
  /** Last custom metal hex; strokes store the hex (or preset id) in `color`. */
  let customMetalHex = "#c45a7a";
  let metalPreset = DEFAULT_METAL_PRESET;
  /** @type {HTMLElement | null} */
  let colorPickerEl = null;
  /** @type {null | "metal" | "glass"} */
  let colorPickerTarget = null;
  /** @type {{h:number,s:number,v:number}} */
  let pickerHsv = { h: 340, s: 0.55, v: 0.77 };

  /** @type {Stroke[]} */
  let strokes = [];
  /** @type {Stroke | null} */
  let activeStroke = null;
  /** @type {number | null} */
  let selectedId = null;
  let nextStrokeId = 1;
  /** @type {Stroke | null} */
  let strokeClipboard = null;

  /** @type {{strokes: Stroke[], selectedId: number|null}[]} */
  let undoStack = [];
  /** @type {{strokes: Stroke[], selectedId: number|null}[]} */
  let redoStack = [];

  /** @type {"draw"|"select"|"erase"} */
  let tool = "draw";
  /** @type {"metal"|"glass"} */
  let material = "metal";
  /** @type {null | "metal" | "glass" | "size"} */
  let openLibrary = null;
  /** Remembered brush sizes for metal draw, glass draw, and eraser. */
  let sizes = { metal: 20, glass: 20, eraser: 20 };
  let thickness = Number(thicknessInput.value) || 20;
  let dpr = 1;
  let width = 0;
  let height = 0;

  /** @type {null | {kind: string, start: Pt, origin: object, last: Pt, strokeId?: number, moved?: boolean, erased?: boolean}} */
  let drag = null;
  /** @type {Pt | null} */
  let eraseCursor = null;

  function cloneStrokes(list) {
    return list.map((s) => ({
      id: s.id,
      kind: s.kind,
      color: s.color,
      width: s.width,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));
  }

  function snapshot() {
    return {
      strokes: cloneStrokes(strokes),
      selectedId,
    };
  }

  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    syncChrome();
  }

  function applySnapshot(state) {
    strokes = cloneStrokes(state.strokes);
    selectedId = state.selectedId;
    if (selectedId != null && !strokes.some((s) => s.id === selectedId)) {
      selectedId = null;
    }
    syncChrome();
    markAllDirty();
    render();
  }

  function undo() {
    if (activeStroke) {
      markDirty(activeStroke.kind);
      activeStroke = null;
      drag = null;
      render();
      return;
    }
    if (undoStack.length === 0) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
  }

  function syncChrome() {
    undoBtn.disabled = undoStack.length === 0 && !activeStroke;
    redoBtn.disabled = redoStack.length === 0;
    const canDelete = selectedId != null && tool === "select";
    deleteBtn.disabled = !canDelete;
    deleteBtn.hidden = !canDelete;
    duplicateBtn.disabled = !canDelete;
    duplicateBtn.hidden = !canDelete;
    const hasContent = strokes.length > 0 || !!activeStroke;
    clearBtn.hidden = !hasContent;
  }

  function closeColorPicker() {
    colorPickerTarget = null;
    if (colorPickerEl) colorPickerEl.hidden = true;
  }

  function closeLibraries() {
    if (openLibrary == null && colorPickerTarget == null) return;
    openLibrary = null;
    metalLibrary.hidden = true;
    glassLibrary.hidden = true;
    metalChevron.setAttribute("aria-expanded", "false");
    glassChevron.setAttribute("aria-expanded", "false");
    sizePanel.hidden = true;
    sizeBtn.setAttribute("aria-expanded", "false");
    closeColorPicker();
  }

  function sizeActiveKey() {
    return tool === "erase" ? "eraser" : material;
  }

  function clampSize(n) {
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)));
  }

  /** Map brush size to the dock preview-dot diameter (CSS rem). */
  function sizeDotRem(n) {
    const t = (clampSize(n) - SIZE_MIN) / (SIZE_MAX - SIZE_MIN);
    return `${(0.22 + t * 0.5).toFixed(3)}rem`;
  }

  function syncSizeUi() {
    thicknessInput.value = String(thickness);
    thicknessInput.setAttribute("aria-valuenow", String(thickness));
    sizeBtnDot.style.setProperty("--size-dot", sizeDotRem(thickness));
    sizeBtnLabel.textContent = String(thickness);
    sizeBtn.title = `Size ${thickness}`;
    sizeBtn.setAttribute("aria-label", `Size ${thickness}`);
    if (document.activeElement !== thicknessValue) {
      thicknessValue.value = String(thickness);
    }
    sizePresetsEl.querySelectorAll(".size-preset").forEach((b) => {
      const on = Number(b.dataset.size) === thickness;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  function setThickness(next) {
    thickness = clampSize(next);
    sizes[sizeActiveKey()] = thickness;
    syncSizeUi();
    if (tool === "erase") syncEraseCursor();
  }

  function applySizeFromContext() {
    thickness = sizes[sizeActiveKey()];
    syncSizeUi();
    if (tool === "erase") syncEraseCursor();
  }

  function commitThicknessValue() {
    const raw = thicknessValue.value.trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || raw === "") {
      thicknessValue.value = String(thickness);
      return;
    }
    setThickness(n);
  }

  function syncMaterialSwatches() {
    const metal = metalPresetById(metalPreset);
    const metalCustomOn = isCustomHex(metalPreset);
    metalSwatch.dataset.preset = metalCustomOn ? "custom" : metal.id;
    metalSwatch.style.setProperty("--sw-light", metal.light);
    metalSwatch.style.setProperty("--sw-deep", metal.deep);
    metalMain.title = `${metal.name} metal`;
    metalMain.setAttribute("aria-label", `${metal.name} metal`);

    const glass = glassColorById(glassColor);
    const glassCustomOn = isCustomHex(glassColor);
    glassSwatch.style.setProperty("--sw-light", glass.light);
    glassSwatch.style.setProperty("--sw-deep", glass.deep);
    glassMain.title = `${glass.name} glass`;
    glassMain.setAttribute("aria-label", `${glass.name} glass`);

    // Palette custom buttons stay rainbow; only the dock swatch shows the picked color.
    metalLibrary.querySelectorAll(".preset-swatch").forEach((b) => {
      const on =
        b.dataset.preset === "custom"
          ? metalCustomOn
          : b.dataset.preset === metalPreset;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });

    glassLibrary.querySelectorAll(".preset-swatch").forEach((b) => {
      const on =
        b.dataset.preset === "custom"
          ? glassCustomOn
          : b.dataset.preset === glassColor;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  function syncDock() {
    const toolBtns = [
      [drawBtn, "draw"],
      [selectBtn, "select"],
      [eraseBtn, "erase"],
    ];
    for (const [btn, id] of toolBtns) {
      const on = tool === id;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }

    const metalOn = material === "metal";
    const glassOn = material === "glass";
    metalSplit.classList.toggle("active", metalOn);
    glassSplit.classList.toggle("active", glassOn);
    metalMain.classList.toggle("active", metalOn);
    glassMain.classList.toggle("active", glassOn);
    metalMain.setAttribute("aria-pressed", String(metalOn));
    glassMain.setAttribute("aria-pressed", String(glassOn));

    syncMaterialSwatches();
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (silverGL) {
      try {
        silverGL.resize(width, height, dpr);
      } catch (err) {
        disableGL(err);
      }
    }
    if (glassGL) {
      try {
        glassGL.resize(width, height, dpr);
      } catch (err) {
        disableGlassGL(err);
      }
    }
    glassLayer.canvas.width = Math.floor(width * dpr);
    glassLayer.canvas.height = Math.floor(height * dpr);
    glassLayer.dist.width = glassLayer.canvas.width;
    glassLayer.dist.height = glassLayer.canvas.height;
    metal.layer.width = glassLayer.canvas.width;
    metal.layer.height = glassLayer.canvas.height;
    // markAllDirty clears the per-color glass cache after the layer bitmaps resize
    markAllDirty();

    render();
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height,
    };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function pointInDisk(pt, center, r) {
    return dist(pt, center) <= r;
  }

  /** Intersection points of segment a→b with circle (center, r), ordered along the segment. */
  function segmentCircleHits(a, b, center, r) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - center.x;
    const fy = a.y - center.y;
    const A = dx * dx + dy * dy;
    if (A < 1e-12) return [];
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return [];
    const sqrt = Math.sqrt(disc);
    const ts = [];
    for (const sign of [-1, 1]) {
      const t = (-B + sign * sqrt) / (2 * A);
      if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
    }
    ts.sort((u, v) => u - v);
    return ts.map((t) => ({ x: a.x + t * dx, y: a.y + t * dy }));
  }

  function strokeIntersectsDisk(s, center, r) {
    const pts = s.points;
    if (pts.length === 0) return false;
    if (pts.length === 1) return pointInDisk(pts[0], center, r);
    for (const pt of pts) {
      if (pointInDisk(pt, center, r)) return true;
    }
    for (let j = 1; j < pts.length; j++) {
      if (distToSegment(center, pts[j - 1], pts[j]) <= r) return true;
    }
    return false;
  }

  /**
   * Clip a polyline to the outside of a disk. Returns zero or more point lists
   * (fragments that remain after punching the circle through the path).
   */
  function clipPolylineOutsideDisk(points, center, r) {
    if (points.length === 0) return [];
    if (points.length === 1) {
      return pointInDisk(points[0], center, r)
        ? []
        : [[{ x: points[0].x, y: points[0].y }]];
    }

    /** @type {Pt[][]} */
    const fragments = [];
    /** @type {Pt[] | null} */
    let current = null;

    const copy = (pt) => ({ x: pt.x, y: pt.y });
    const pushPt = (pt) => {
      if (!current) {
        current = [copy(pt)];
        return;
      }
      const last = current[current.length - 1];
      if (last.x !== pt.x || last.y !== pt.y) current.push(copy(pt));
    };
    const endFrag = () => {
      if (current && current.length > 0) fragments.push(current);
      current = null;
    };

    let prev = points[0];
    let prevInside = pointInDisk(prev, center, r);
    if (!prevInside) pushPt(prev);

    for (let i = 1; i < points.length; i++) {
      const curr = points[i];
      const currInside = pointInDisk(curr, center, r);
      const hits = segmentCircleHits(prev, curr, center, r);

      if (!prevInside && !currInside) {
        if (hits.length >= 2) {
          pushPt(hits[0]);
          endFrag();
          pushPt(hits[hits.length - 1]);
          pushPt(curr);
        } else {
          pushPt(curr);
        }
      } else if (!prevInside && currInside) {
        if (hits.length > 0) pushPt(hits[0]);
        endFrag();
      } else if (prevInside && !currInside) {
        if (hits.length > 0) pushPt(hits[hits.length - 1]);
        pushPt(curr);
      }
      // both inside: discard this span

      prev = curr;
      prevInside = currInside;
    }
    endFrag();
    return fragments;
  }

  function strokeHit(s, p) {
    const thresh = Math.max(8, s.width * 0.55);
    const pts = s.points;
    if (pts.length === 1) return dist(p, pts[0]) <= thresh;
    for (let j = 1; j < pts.length; j++) {
      if (distToSegment(p, pts[j - 1], pts[j]) <= thresh) return true;
    }
    return false;
  }

  function hitStrokeAt(p) {
    // Silver sits over glass, so test silver first; within a kind, topmost first
    for (const kind of ["silver", "glass"]) {
      for (let i = strokes.length - 1; i >= 0; i--) {
        const s = strokes[i];
        if (s.kind === kind && strokeHit(s, p)) return s;
      }
    }
    return null;
  }

  function setTool(next) {
    if (tool === next) return;
    tool = next;
    stage.dataset.tool = next;
    closeLibraries();
    if (next !== "select") {
      selectedId = null;
      stage.classList.remove("over-object");
    }
    if (next !== "select") stage.classList.remove("dragging");
    if (next !== "erase") eraseCursor = null;
    applySizeFromContext();
    syncDock();
    syncChrome();
    render();
  }

  function setMaterial(next, opts = {}) {
    material = next;
    if (opts.draw !== false) tool = "draw";
    stage.dataset.tool = tool;
    if (tool !== "select") {
      selectedId = null;
      stage.classList.remove("over-object");
    }
    if (tool !== "erase") eraseCursor = null;
    applySizeFromContext();
    if (!opts.keepLibrary) closeLibraries();
    syncDock();
    syncChrome();
    render();
  }

  function selectMetalPreset(id, opts = {}) {
    metalPreset = id;
    setMaterial("metal", opts);
  }

  function selectMetalCustom(hex, opts = {}) {
    const h = hex.toLowerCase();
    customMetalHex = h;
    metalPreset = h;
    setMaterial("metal", opts);
  }

  function selectGlassColor(id, opts = {}) {
    if (isCustomHex(id)) {
      glassColor = id.toLowerCase();
      customGlassHex = glassColor;
    } else {
      glassColor = id;
    }
    setMaterial("glass", opts);
  }

  function syncPickerUI() {
    if (!colorPickerEl) return;
    const hex = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
    const hueHex = hsvToHex(pickerHsv.h, 1, 1);
    const preview = colorPickerEl.querySelector(".color-picker-preview");
    const sv = colorPickerEl.querySelector(".color-picker-sv");
    const svKnob = colorPickerEl.querySelector(".color-picker-sv-knob");
    const hueKnob = colorPickerEl.querySelector(".color-picker-hue-knob");
    if (preview) preview.style.background = hex;
    if (sv) sv.style.setProperty("--picker-hue", hueHex);
    if (svKnob) {
      svKnob.style.left = `${pickerHsv.s * 100}%`;
      svKnob.style.top = `${(1 - pickerHsv.v) * 100}%`;
    }
    if (hueKnob) {
      hueKnob.style.left = `${(pickerHsv.h / 360) * 100}%`;
    }
  }

  function applyPickerColor(keepLibrary = true) {
    const hex = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
    if (colorPickerTarget === "glass") {
      selectGlassColor(hex, { keepLibrary });
    } else if (colorPickerTarget === "metal") {
      selectMetalCustom(hex, { keepLibrary });
    }
    syncPickerUI();
  }

  function ensureColorPicker() {
    if (colorPickerEl) return colorPickerEl;

    const root = document.createElement("div");
    root.className = "color-picker";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Custom color");
    root.innerHTML = `
      <div class="color-picker-preview" aria-hidden="true"></div>
      <div class="color-picker-sv" tabindex="0" role="slider" aria-label="Saturation and brightness">
        <div class="color-picker-sv-knob" aria-hidden="true"></div>
      </div>
      <div class="color-picker-hue" tabindex="0" role="slider" aria-label="Hue">
        <div class="color-picker-hue-knob" aria-hidden="true"></div>
      </div>
    `;

    const sv = root.querySelector(".color-picker-sv");
    const hue = root.querySelector(".color-picker-hue");

    const bindPad = (el, onMove) => {
      let dragging = false;
      const move = (e) => {
        if (!dragging) return;
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        onMove(x, y);
        applyPickerColor(true);
      };
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        el.setPointerCapture(e.pointerId);
        move(e);
      });
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      });
      el.addEventListener("pointercancel", () => {
        dragging = false;
      });
    };

    bindPad(sv, (x, y) => {
      pickerHsv.s = x;
      pickerHsv.v = 1 - y;
    });
    bindPad(hue, (x) => {
      pickerHsv.h = x * 360;
    });

    colorPickerEl = root;
    return root;
  }

  function openCustomColorPicker(which) {
    const host = which === "metal" ? metalSplit : glassSplit;
    const picker = ensureColorPicker();
    if (picker.parentElement !== host) host.appendChild(picker);

    // Keep the matching library open under the picker; close Size.
    openLibrary = which;
    const isMetal = which === "metal";
    metalLibrary.hidden = !isMetal;
    glassLibrary.hidden = isMetal;
    metalChevron.setAttribute("aria-expanded", String(isMetal));
    glassChevron.setAttribute("aria-expanded", String(!isMetal));
    sizePanel.hidden = true;
    sizeBtn.setAttribute("aria-expanded", "false");

    const hex =
      which === "glass"
        ? isCustomHex(glassColor)
          ? glassColor
          : customGlassHex
        : isCustomHex(metalPreset)
          ? metalPreset
          : customMetalHex;
    pickerHsv = hexToHsv(hex);
    colorPickerTarget = which;
    picker.hidden = false;
    applyPickerColor(true);
  }

  function toggleLibrary(which) {
    if (openLibrary === which) {
      closeLibraries();
      return;
    }
    closeColorPicker();
    openLibrary = which;
    const isMetal = which === "metal";
    metalLibrary.hidden = !isMetal;
    glassLibrary.hidden = isMetal;
    metalChevron.setAttribute("aria-expanded", String(isMetal));
    glassChevron.setAttribute("aria-expanded", String(!isMetal));
    sizePanel.hidden = true;
    sizeBtn.setAttribute("aria-expanded", "false");
    syncMaterialSwatches();
  }

  function toggleSizePanel() {
    if (openLibrary === "size") {
      closeLibraries();
      return;
    }
    closeColorPicker();
    openLibrary = "size";
    metalLibrary.hidden = true;
    glassLibrary.hidden = true;
    metalChevron.setAttribute("aria-expanded", "false");
    glassChevron.setAttribute("aria-expanded", "false");
    sizePanel.hidden = false;
    sizeBtn.setAttribute("aria-expanded", "true");
    syncSizeUi();
  }

  function buildSizePresets() {
    sizePresetsEl.replaceChildren();
    SIZE_PRESETS.forEach((size, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "size-preset";
      b.dataset.size = String(size);
      b.style.setProperty("--dot", SIZE_PRESET_DOTS[i]);
      b.title = `Size ${size}`;
      b.setAttribute("aria-label", `Size ${size}`);
      b.setAttribute("role", "option");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setThickness(size);
      });
      sizePresetsEl.appendChild(b);
    });
  }

  function makeCustomSwatchButton(which) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      which === "metal" ? "preset-swatch metal custom" : "preset-swatch custom";
    b.dataset.preset = "custom";
    b.title = "Custom";
    b.setAttribute("aria-label", "Custom color");
    b.setAttribute("role", "option");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openCustomColorPicker(which);
    });
    return b;
  }

  function buildLibraries() {
    metalLibrary.textContent = "";

    const appendMetalPreset = (c) => {
      if (!c) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset-swatch metal";
      b.dataset.preset = c.id;
      b.title = c.name;
      b.setAttribute("aria-label", c.name);
      b.setAttribute("role", "option");
      b.style.setProperty("--sw-light", c.light);
      b.style.setProperty("--sw-deep", c.deep);
      b.addEventListener("click", () => selectMetalPreset(c.id));
      metalLibrary.appendChild(b);
    };

    // Top row: gold, rose, custom — bottom: silver, dark gray, black
    appendMetalPreset(METAL_PRESETS.find((c) => c.id === "gold"));
    appendMetalPreset(METAL_PRESETS.find((c) => c.id === "rose"));
    metalLibrary.appendChild(makeCustomSwatchButton("metal"));
    appendMetalPreset(METAL_PRESETS.find((c) => c.id === "silver"));
    appendMetalPreset(METAL_PRESETS.find((c) => c.id === "dark-gray"));
    appendMetalPreset(METAL_PRESETS.find((c) => c.id === "black"));

    glassLibrary.textContent = "";

    const appendGlassPreset = (c) => {
      if (!c) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset-swatch";
      b.dataset.preset = c.id;
      b.title = c.name;
      b.setAttribute("aria-label", c.name);
      b.setAttribute("role", "option");
      b.style.setProperty("--sw-light", c.light);
      b.style.setProperty("--sw-deep", c.deep);
      b.addEventListener("click", () => selectGlassColor(c.id));
      glassLibrary.appendChild(b);
    };

    // Top row: green, amber, custom — bottom: pale blue, white, deep blue
    appendGlassPreset(GLASS_COLORS.find((c) => c.id === "deep-green"));
    appendGlassPreset(GLASS_COLORS.find((c) => c.id === "amber"));
    glassLibrary.appendChild(makeCustomSwatchButton("glass"));
    appendGlassPreset(GLASS_COLORS.find((c) => c.id === "pale-blue"));
    appendGlassPreset(GLASS_COLORS.find((c) => c.id === "white"));
    appendGlassPreset(GLASS_COLORS.find((c) => c.id === "deep-blue"));

    syncDock();
  }

  /**
   * Punch through stroke geometry under the Size brush.
   * Hit radius matches the visible erase ring (thickness / 2). Thick strokes may
   * leave a thin remnant under the ring; bump Size or pass again to clear it.
   */
  function eraseAt(p) {
    const brushR = thickness / 2;
    let changed = false;
    let clearedSelection = false;
    /** @type {Set<"silver"|"glass">} */
    const dirtyKinds = new Set();
    /** @type {Stroke[]} */
    const next = [];

    for (const s of strokes) {
      const radius = brushR;
      if (!strokeIntersectsDisk(s, p, radius)) {
        next.push(s);
        continue;
      }

      const frags = clipPolylineOutsideDisk(s.points, p, radius);
      if (!drag.erased) {
        pushHistory();
        drag.erased = true;
      }
      changed = true;
      dirtyKinds.add(s.kind);

      if (frags.length === 0) {
        if (selectedId === s.id) {
          selectedId = null;
          clearedSelection = true;
        }
        continue;
      }

      s.points = frags[0];
      next.push(s);
      for (let f = 1; f < frags.length; f++) {
        next.push({
          id: nextStrokeId++,
          kind: s.kind,
          color: s.color,
          width: s.width,
          points: frags[f],
        });
      }
    }

    if (!changed) return;

    strokes = next;
    if (clearedSelection) syncChrome();
    for (const kind of dirtyKinds) {
      // Defer silver remold while glass is live-erased; settle on pointer up.
      markDirty(kind, { deferMetal: true });
    }
    // Same cadence as draw: remold every sample so material vanishes immediately.
    scheduleRender("live");
  }

  function syncEraseCursor() {
    if (tool !== "erase" || !eraseCursor) {
      eraseCursorEl.hidden = true;
      return;
    }
    const d = thickness;
    eraseCursorEl.hidden = false;
    eraseCursorEl.style.width = `${d}px`;
    eraseCursorEl.style.height = `${d}px`;
    eraseCursorEl.style.transform = `translate(${eraseCursor.x}px, ${eraseCursor.y}px) translate(-50%, -50%)`;
  }

  function drawWorkbench() {
    // Brighter studio-like field so polished silver has something luminous to "reflect"
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, "#e4ebf0");
    g.addColorStop(0.4, "#f2f5f6");
    g.addColorStop(1, "#dde6e0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // Soft key light pool from upper-left
    const key = ctx.createRadialGradient(
      width * 0.32,
      height * 0.22,
      Math.min(width, height) * 0.05,
      width * 0.45,
      height * 0.4,
      Math.max(width, height) * 0.7
    );
    key.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    key.addColorStop(0.45, "rgba(255, 255, 255, 0.12)");
    key.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.03;
    for (let i = 0; i < 160; i++) {
      const x = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const y = Math.abs(Math.sin(i * 78.233) * 93758.1234) % 1;
      ctx.fillStyle = i % 2 === 0 ? "#1c242c" : "#ffffff";
      ctx.fillRect(x * width, y * height, 1.2, 1.2);
    }
    ctx.restore();

    const vig = ctx.createRadialGradient(
      width * 0.5,
      height * 0.42,
      Math.min(width, height) * 0.22,
      width * 0.5,
      height * 0.55,
      Math.max(width, height) * 0.75
    );
    vig.addColorStop(0, "rgba(255,255,255,0)");
    vig.addColorStop(1, "rgba(70, 88, 100, 0.1)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }

  function strokePolyline(points, c = ctx) {
    if (points.length < 2) return;
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const midX = (prev.x + curr.x) / 2;
      const midY = (prev.y + curr.y) / 2;
      c.quadraticCurveTo(prev.x, prev.y, midX, midY);
    }
    const last = points[points.length - 1];
    c.lineTo(last.x, last.y);
    c.stroke();
  }

  // ---------------------------------------------------------------------------
  // Liquid silver
  //
  // Strokes are not drawn as separate tubes. Instead every stroke is rasterised
  // into a soft "metaball" field, the fields are summed, and the result is
  // thresholded — so strokes that touch or come close fuse into one pool, with
  // rounded fillets in the crotches, like molten solder.
  //
  // That merged silhouette is then turned into a height map (rounded edge +
  // gentle dome), normals are taken from it, and each pixel reflects a small
  // procedural studio environment — which is what gives the chrome look.
  // ---------------------------------------------------------------------------

  const SILVER = {
    goo: 0.55, // blur radius relative to stroke weight — higher = stickier, more melting
    threshold: 0.42, // field level where the metal surface sits
    liveArea: 1000000, // max bitmap pixels while drawing / dragging
    fullArea: 4000000, // max bitmap pixels for the settled render
  };

  // GPU renderer (silver-gl.js). Falls back to the CPU renderer below if unavailable.
  let silverGL = null;
  try {
    silverGL = window.SilverGL ? window.SilverGL.create() : null;
  } catch (err) {
    console.warn("[jewl] WebGL silver unavailable, using CPU renderer", err);
    silverGL = null;
  }

  function disableGL(err) {
    console.warn("[jewl] WebGL silver failed, using CPU renderer", err);
    silverGL = null;
    metal.builtVersion = -1;
    metal.glEmpty = true;
  }

  const metal = {
    glEmpty: true,
    // device-pixel cache of the GPU silver: molded strokes, then on-top strokes over them
    layer: document.createElement("canvas"),
    canvas: document.createElement("canvas"),
    version: 0,
    builtVersion: -1,
    builtQuality: "",
    empty: true,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
  const metalCtx = metal.canvas.getContext("2d");
  const metalLayerCtx = metal.layer.getContext("2d");
  const maskCanvas = document.createElement("canvas");
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });

  const bufPool = {};
  function buf(name, n, Type = Float32Array) {
    let b = bufPool[name];
    if (!b || b.length < n) {
      b = new Type(n);
      bufPool[name] = b;
    }
    return b;
  }

  /**
   * @param {"silver"|"glass"} kind
   * @param {{ deferMetal?: boolean }} [opts] - when deferMetal, skip remolding silver
   *   during live glass paint/move; call again without it on settle.
   */
  function markDirty(kind, opts) {
    if (kind === "glass") {
      glassLayer.version++;
      // silver reads the glass layer to mold around it; defer during live glass gestures
      if (!opts?.deferMetal && strokes.some((s) => s.kind === "silver")) metal.version++;
    } else {
      metal.version++;
    }
  }

  function markAllDirty() {
    metal.version++;
    glassLayer.version++;
    clearGlassGroupCache();
  }

  // ---------------------------------------------------------------------------
  // Paintable sea glass
  //
  // Glass strokes go through the same metaball / distance-field pipeline as the
  // silver, but are shaded as frosted, translucent, tinted glass. Each palette
  // color is its own group: strokes of one color fuse together, and groups are
  // stacked in the order they were first painted. Each group is rendered by the
  // GPU and composited into a cached layer, which sits under the silver.
  // ---------------------------------------------------------------------------

  const GLASS = {
    goo: 0.65, // a bit stickier than silver so painted pieces stay smooth and pebble-like
    threshold: 0.42,
    domeK: 0.4, // nearly flat top: glass sits flush with the metal instead of domed above it
  };

  // Where silver touches or crosses glass, the glass acts as a solid obstacle for the liquid
  // metal (silver-gl.js): metal is pushed out of the stone and piles up along its edge, wets
  // along the contour, and turns flat and bezel-like next to it. The glass never changes shape.
  // Silver drawn entirely inside a glass piece is not molded; it sits on top.
  const WRAP = {
    lipOverlap: 1.5, // px the metal may overlap the glass edge (a bezel lip)
    bandWidth: 0.35, // width of the edge band the pushed metal piles into, x silver Weight (3 to 14 px)
    displace: 1.0, // how much of the pushed-out metal reappears along the edge (1 = all of it)
    wet: 0.6, // how far metal touching the glass creeps along its edge
    bevel: 0.8, // slope of the narrow bevel where metal meets glass
    tintBleed: 0.2, // hint of glass color right at the contact edge (0 to 1)
    seam: 0.6, // darkness of the thin line where metal meets glass (0 to 1)
    flattenGlass: 0.9, // hides the glass's frosted, rounded edge next to the metal (0 to 1)
    flattenWidth: 10, // px of glass edge flattened next to the metal
  };

  let glassGL = null;
  try {
    glassGL = window.SilverGL ? window.SilverGL.create("glass") : null;
  } catch (err) {
    console.warn("[jewl] WebGL glass unavailable, using simple glass", err);
    glassGL = null;
  }

  function disableGlassGL(err) {
    console.warn("[jewl] WebGL glass failed, using simple glass", err);
    glassGL = null;
    glassLayer.builtVersion = -1;
    clearGlassGroupCache();
  }

  const glassLayer = {
    canvas: document.createElement("canvas"),
    // signed distance to the glass edge (grey, 0.5 = on the edge); read by the silver pass
    dist: document.createElement("canvas"),
    version: 0,
    builtVersion: -1,
    builtQuality: "full",
    empty: true,
    hasDist: false,
  };
  const glassLayerCtx = glassLayer.canvas.getContext("2d");
  const glassDistCtx = glassLayer.dist.getContext("2d");

  // Per-color GPU results so painting one color does not re-render the others.
  /** @type {Map<string, {sig:string, quality:string, hasDist:boolean, color:HTMLCanvasElement, dist:HTMLCanvasElement, x:number, y:number, w:number, h:number}>} */
  const glassGroupCache = new Map();

  function clearGlassGroupCache() {
    glassGroupCache.clear();
  }

  function strokesOfKind(kind) {
    const list = strokes.filter((s) => s.kind === kind);
    if (activeStroke && activeStroke.kind === kind) list.push(activeStroke);
    return list;
  }

  function hasSilverStrokes() {
    return strokesOfKind("silver").length > 0;
  }

  /** Content signature for a same-color glass group (invalidates when the stroke geometry changes). */
  function glassGroupSignature(group) {
    const parts = [];
    for (const s of group) {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      parts.push(`${s.id}:${s.points.length}:${s.width}:${a.x.toFixed(1)},${a.y.toFixed(1)}:${b.x.toFixed(1)},${b.y.toFixed(1)}`);
    }
    return parts.join("|");
  }

  function ensureGroupCacheCanvases(entry, sw, sh) {
    if (entry.color.width !== sw || entry.color.height !== sh) {
      entry.color.width = sw;
      entry.color.height = sh;
    }
    if (entry.dist.width !== sw || entry.dist.height !== sh) {
      entry.dist.width = sw;
      entry.dist.height = sh;
    }
  }

  /**
   * @param {"live"|"full"} quality
   * @param {{ needDist?: boolean }} [opts]
   */
  function buildGlassLayer(quality = "full", opts) {
    const needDist = !!(opts && opts.needDist);
    const c = glassLayerCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, glassLayer.canvas.width, glassLayer.canvas.height);
    // distance layer starts as "far outside" (black); groups are max-ed in with "lighten"
    const dc = glassDistCtx;
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.globalCompositeOperation = "source-over";
    dc.fillStyle = "#000";
    dc.fillRect(0, 0, glassLayer.dist.width, glassLayer.dist.height);
    glassLayer.hasDist = false;
    glassLayer.builtVersion = glassLayer.version;
    glassLayer.builtQuality = quality;

    const list = strokesOfKind("glass");
    glassLayer.empty = list.length === 0;
    if (glassLayer.empty) {
      clearGlassGroupCache();
      return;
    }

    // Group by color, in order of first appearance
    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.color)) groups.set(s.color, []);
      groups.get(s.color).push(s);
    }

    // Drop cache entries for colors that are no longer present
    for (const key of glassGroupCache.keys()) {
      if (!groups.has(key)) glassGroupCache.delete(key);
    }

    const maxArea = quality === "live" ? SILVER.liveArea : 0;
    const upscale = quality === "live";

    for (const [colorId, group] of groups) {
      const col = glassColorById(colorId);
      if (glassGL) {
        const sig = glassGroupSignature(group);
        let entry = glassGroupCache.get(colorId);
        const cacheHit =
          entry &&
          entry.sig === sig &&
          entry.quality === quality &&
          (!needDist || entry.hasDist);

        if (!cacheHit) {
          let rect = null;
          try {
            rect = glassGL.render(group, {
              goo: GLASS.goo,
              threshold: GLASS.threshold,
              domeK: GLASS.domeK,
              tintLight: col.lightRgb,
              tintDeep: col.deepRgb,
              maxArea,
            });
          } catch (err) {
            disableGlassGL(err);
            buildGlassLayer(quality, opts);
            return;
          }
          if (!rect) {
            glassGroupCache.delete(colorId);
            continue;
          }
          if (!entry) {
            entry = {
              sig: "",
              quality,
              hasDist: false,
              color: document.createElement("canvas"),
              dist: document.createElement("canvas"),
              x: 0,
              y: 0,
              w: 0,
              h: 0,
            };
            glassGroupCache.set(colorId, entry);
          }
          ensureGroupCacheCanvases(entry, rect.sw, rect.sh);
          const ec = entry.color.getContext("2d");
          ec.setTransform(1, 0, 0, 1, 0, 0);
          ec.clearRect(0, 0, rect.sw, rect.sh);
          ec.imageSmoothingEnabled = false;
          ec.drawImage(glassGL.canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);

          entry.hasDist = false;
          if (needDist) {
            const dr = glassGL.renderDist();
            if (dr) {
              const ed = entry.dist.getContext("2d");
              ed.setTransform(1, 0, 0, 1, 0, 0);
              ed.clearRect(0, 0, rect.sw, rect.sh);
              ed.imageSmoothingEnabled = false;
              ed.drawImage(glassGL.canvas, dr.sx, dr.sy, dr.sw, dr.sh, 0, 0, dr.sw, dr.sh);
              entry.hasDist = true;
            }
          }
          entry.sig = sig;
          entry.quality = quality;
          entry.x = rect.x;
          entry.y = rect.y;
          entry.w = rect.w;
          entry.h = rect.h;
        }

        // Composite cached group into the full-canvas glass layer (upscale when live)
        c.imageSmoothingEnabled = upscale;
        c.drawImage(
          entry.color,
          0,
          0,
          entry.color.width,
          entry.color.height,
          entry.x * dpr,
          entry.y * dpr,
          entry.w * dpr,
          entry.h * dpr
        );
        if (needDist && entry.hasDist) {
          dc.imageSmoothingEnabled = upscale;
          dc.globalCompositeOperation = "lighten";
          dc.drawImage(
            entry.dist,
            0,
            0,
            entry.dist.width,
            entry.dist.height,
            entry.x * dpr,
            entry.y * dpr,
            entry.w * dpr,
            entry.h * dpr
          );
          dc.globalCompositeOperation = "source-over";
          glassLayer.hasDist = true;
        }
      } else {
        // Simple fallback: flat translucent round-cap strokes
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.lineCap = "round";
        c.lineJoin = "round";
        c.globalAlpha = 0.82;
        c.strokeStyle = col.deep;
        c.fillStyle = col.deep;
        for (const s of group) {
          c.lineWidth = s.width;
          if (s.points.length === 1) {
            c.beginPath();
            c.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2);
            c.fill();
          } else {
            strokePolyline(s.points, c);
          }
        }
        c.globalAlpha = 1;
        c.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  /** @param {"live"|"full"} [quality] */
  function drawGlass(quality = "full") {
    stage.dataset.glassRenderer = glassGL ? "webgl" : "simple";
    // Dist lets silver wrap glass; keep it whenever silver exists (including live erase remolds).
    const needDist = hasSilverStrokes();
    const stale =
      glassLayer.builtVersion !== glassLayer.version ||
      (needDist && !glassLayer.hasDist && !glassLayer.empty) ||
      (quality === "full" && glassLayer.builtQuality !== "full");
    if (stale) buildGlassLayer(quality, { needDist });
    if (glassLayer.empty) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(glassLayer.canvas, 0, 0);
    ctx.restore();
  }

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /** One sliding-window box blur pass along a single axis. */
  function blur1d(src, dst, count, len, step, lineStep, r) {
    const inv = 1 / (2 * r + 1);
    for (let l = 0; l < count; l++) {
      const base = l * lineStep;
      let acc = 0;
      const lim = Math.min(r, len - 1);
      for (let i = 0; i <= lim; i++) acc += src[base + i * step];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = acc * inv;
        const add = i + r + 1;
        if (add < len) acc += src[base + add * step];
        const sub = i - r;
        if (sub >= 0) acc -= src[base + sub * step];
      }
    }
  }

  /** Gaussian-ish blur (three box passes each way), in place. */
  function gaussBlur(a, tmp, w, h, sigma) {
    if (sigma < 0.5) return;
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    for (let k = 0; k < 3; k++) {
      blur1d(a, tmp, h, w, 1, w, r);
      blur1d(tmp, a, w, h, w, 1, r);
    }
  }

  function edt1d(f, d, v, z, n) {
    let k = 0;
    v[0] = 0;
    z[0] = -1e20;
    z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let p = v[k];
      let s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) {
        k--;
        p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  }

  /** Euclidean distance from every inside pixel to the nearest outside pixel. */
  function distanceInside(field, thr, w, h, out) {
    const INF = 1e10;
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = field[y * w + x] >= thr ? INF : 0;
      edt1d(f, d, v, z, h);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = out[row + x];
      edt1d(f, d, v, z, w);
      for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(d[x]);
    }
  }

  // --- Procedural studio environment the silver reflects -------------------
  function unit3(x, y, z) {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }
  const ENV_KEY = unit3(-0.5, -0.62, 0.6); // big soft box, upper-left
  const ENV_STRIP = unit3(0.78, -0.3, 0.28); // thin strip light, right
  const ENV_DARK = unit3(0.55, 0.65, 0.3); // black flag, lower-right
  const ENV_DARK2 = unit3(-0.78, 0.4, 0.22); // second, smaller flag, lower-left

  /** Luminance seen along reflection direction r (unit). z+ points at the viewer. */
  function envLum(rx, ry, rz) {
    // Bright ceiling, mid-grey horizon, light bench below
    let v = rz >= 0 ? 0.74 + 0.12 * rz : 0.74 + 0.16 * rz;
    // Dark wall ring between zenith and horizon — gives the classic chrome rim band
    const t = (rz - 0.36) / 0.2;
    v *= 1 - 0.82 * Math.exp(-t * t);

    const dk = rx * ENV_KEY[0] + ry * ENV_KEY[1] + rz * ENV_KEY[2];
    v += (1 - v) * smoothstep(0.84, 0.94, dk);

    const dd1 = rx * ENV_DARK[0] + ry * ENV_DARK[1] + rz * ENV_DARK[2];
    v *= 1 - 0.88 * smoothstep(0.3, 0.8, dd1);
    const dd2 = rx * ENV_DARK2[0] + ry * ENV_DARK2[1] + rz * ENV_DARK2[2];
    v *= 1 - 0.7 * smoothstep(0.55, 0.88, dd2);

    const ds = rx * ENV_STRIP[0] + ry * ENV_STRIP[1] + rz * ENV_STRIP[2];
    v = Math.max(v, smoothstep(0.975, 0.992, ds));

    return Math.pow(Math.min(1, Math.max(0, v)), 1.12);
  }

  function emptyMetal() {
    metal.empty = true;
    metal.builtVersion = metal.version;
  }

  function widthBucket(w) {
    return w < 10 ? 0 : w < 20 ? 1 : 2;
  }

  /**
   * CPU shade one same-color metal group into metal.canvas.
   * Returns false when the group has no drawable extent.
   */
  function buildMetalGroup(list, col, quality) {
    // --- Extents + weight statistics
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxW = 0;
    let sumW = 0;
    const bucketMinW = [Infinity, Infinity, Infinity];
    for (const s of list) {
      sumW += s.width;
      maxW = Math.max(maxW, s.width);
      const b = widthBucket(s.width);
      bucketMinW[b] = Math.min(bucketMinW[b], s.width);
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const meanW = sumW / list.length;

    const margin = maxW * 1.1 + 18;
    const x0 = Math.floor(Math.max(minX - margin, -300));
    const y0 = Math.floor(Math.max(minY - margin, -300));
    const x1 = Math.ceil(Math.min(maxX + margin, width + 300));
    const y1 = Math.ceil(Math.min(maxY + margin, height + 300));
    if (x1 - x0 < 2 || y1 - y0 < 2) return false;

    // s = bitmap pixels per CSS pixel. Match the screen's device pixel ratio so
    // the silver is drawn 1:1 with the display; only drop resolution when the
    // bounding box would exceed the pixel budget.
    const area = (x1 - x0) * (y1 - y0);
    const budget = quality === "live" ? SILVER.liveArea : SILVER.fullArea;
    const devArea = area * dpr * dpr;
    const s = dpr * Math.min(1, Math.sqrt(budget / devArea));
    const gw = Math.max(2, Math.ceil((x1 - x0) * s));
    const gh = Math.max(2, Math.ceil((y1 - y0) * s));
    const n = gw * gh;

    // --- 1. Rasterise strokes, one colour channel per weight bucket
    if (maskCanvas.width !== gw || maskCanvas.height !== gh) {
      maskCanvas.width = gw;
      maskCanvas.height = gh;
    }
    const m = maskCtx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = "source-over";
    m.fillStyle = "#000";
    m.fillRect(0, 0, gw, gh);
    m.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    m.globalCompositeOperation = "lighter";
    m.lineCap = "round";
    m.lineJoin = "round";
    const channelColor = ["#f00", "#0f0", "#00f"];
    const bucketUsed = [false, false, false];
    for (const st of list) {
      const b = widthBucket(st.width);
      bucketUsed[b] = true;
      m.strokeStyle = channelColor[b];
      m.fillStyle = channelColor[b];
      m.lineWidth = st.width;
      if (st.points.length === 1) {
        m.beginPath();
        m.arc(st.points[0].x, st.points[0].y, st.width / 2, 0, Math.PI * 2);
        m.fill();
      } else {
        strokePolyline(st.points, m);
      }
    }
    const px = m.getImageData(0, 0, gw, gh).data;

    // --- 2. Metaball field: blur each bucket (radius ~ its thinnest stroke), sum
    const F = buf("F", n);
    const A = buf("A", n);
    const T = buf("T", n);
    F.fill(0, 0, n);
    for (let ch = 0; ch < 3; ch++) {
      if (!bucketUsed[ch]) continue;
      for (let i = 0; i < n; i++) A[i] = px[i * 4 + ch] / 255;
      gaussBlur(A, T, gw, gh, SILVER.goo * bucketMinW[ch] * s);
      for (let i = 0; i < n; i++) F[i] += A[i];
    }

    // --- 3. Merged silhouette
    const thr = SILVER.threshold;
    const C = buf("C", n);
    for (let i = 0; i < n; i++) C[i] = smoothstep(thr - 0.05, thr + 0.05, F[i]);

    // --- 4. Height map: round-over edge + soft dome across larger pools
    const Rg = Math.max(1.5, 0.5 * meanW * s);
    const D = buf("D", n, Float64Array);
    distanceInside(F, thr, gw, gh, D);

    const H = buf("H", n);
    for (let i = 0; i < n; i++) A[i] = C[i];
    gaussBlur(A, T, gw, gh, 1.8 * Rg);
    for (let y = 0; y < gh; y++) {
      const wy = y0 + y / s;
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const di = D[i];
        if (di > 0) {
          const t = Math.min(1, Math.max(0, di - 0.5) / Rg);
          const u = 1 - t;
          const pool = A[i] * A[i];
          // Slow ripples so big pools reflect in swoops instead of one flat tone
          const wx = x0 + x / s;
          const wob =
            Math.sin(wx * 0.034 + Math.sin(wy * 0.021) * 2.1) *
            Math.cos(wy * 0.029 + Math.cos(wx * 0.017) * 1.7);
          H[i] = Rg * Math.sqrt(1 - u * u) + Rg * pool * (1.4 + 0.55 * wob);
        } else {
          H[i] = 0;
        }
      }
    }
    // Take the stair-steps out of the distance field
    gaussBlur(H, T, gw, gh, 1.0);

    // --- 5. Soft shadow source
    const S = buf("S", n);
    for (let i = 0; i < n; i++) S[i] = C[i];
    gaussBlur(S, T, gw, gh, Math.max(1.2, 0.5 * Rg));
    const shScale = Math.min(2, Math.max(0.6, (meanW * 0.5) / 7));
    const sx1 = Math.round(1.0 * shScale * s);
    const sy1 = Math.round(3.0 * shScale * s);
    const sx2 = Math.round(0.3 * shScale * s);
    const sy2 = Math.max(1, Math.round(0.9 * shScale * s));

    // --- 6. Shade: normals from the height map, reflect the studio (metal-tinted)
    if (metal.canvas.width !== gw || metal.canvas.height !== gh) {
      metal.canvas.width = gw;
      metal.canvas.height = gh;
    }
    const img = metalCtx.createImageData(gw, gh);
    const out = img.data;
    const SH_R = 28;
    const SH_G = 36;
    const SH_B = 44;
    const loR = col.deepRgb[0] * 0.15 * 255;
    const loG = col.deepRgb[1] * 0.15 * 255;
    const loB = col.deepRgb[2] * 0.15 * 255;
    const hiR = col.lightRgb[0] * 255;
    const hiG = col.lightRgb[1] * 255;
    const hiB = col.lightRgb[2] * 255;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const c = C[i];

        // Shadow
        const ax = Math.min(gw - 1, Math.max(0, x - sx1));
        const ay = Math.min(gh - 1, Math.max(0, y - sy1));
        const bx = Math.min(gw - 1, Math.max(0, x - sx2));
        const by = Math.min(gh - 1, Math.max(0, y - sy2));
        let aS = 1 - (1 - 0.3 * S[ay * gw + ax]) * (1 - 0.3 * S[by * gw + bx]);
        aS *= 1 - c;

        let r = SH_R;
        let g = SH_G;
        let b = SH_B;
        let alpha = aS;

        if (c > 0.003) {
          const xl = x > 0 ? H[i - 1] : H[i];
          const xr = x < gw - 1 ? H[i + 1] : H[i];
          const yu = y > 0 ? H[i - gw] : H[i];
          const yd = y < gh - 1 ? H[i + gw] : H[i];
          const gx = (xr - xl) * 0.5;
          const gy = (yd - yu) * 0.5;
          const nz = 1 / Math.sqrt(gx * gx + gy * gy + 1);
          const nx = -gx * nz;
          const ny = -gy * nz;
          const v = envLum(2 * nz * nx, 2 * nz * ny, 2 * nz * nz - 1);

          const cr = Math.min(255, loR + hiR * v);
          const cg = Math.min(255, loG + hiG * v);
          const cb = Math.min(255, loB + hiB * v);

          alpha = c + aS * (1 - c);
          const k = aS * (1 - c);
          r = (cr * c + SH_R * k) / alpha;
          g = (cg * c + SH_G * k) / alpha;
          b = (cb * c + SH_B * k) / alpha;
        }

        const o = i * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = alpha * 255;
      }
    }
    metalCtx.putImageData(img, 0, 0);

    metal.x = x0;
    metal.y = y0;
    metal.w = gw / s;
    metal.h = gh / s;
    return true;
  }

  function buildMetal(quality) {
    const list = strokesOfKind("silver");
    if (list.length === 0) {
      metal.builtQuality = quality;
      emptyMetal();
      return;
    }

    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.color)) groups.set(s.color, []);
      groups.get(s.color).push(s);
    }

    const c = metalLayerCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, metal.layer.width, metal.layer.height);
    c.imageSmoothingEnabled = true;
    metal.empty = true;

    for (const [colorId, group] of groups) {
      const col = metalPresetById(colorId);
      if (!buildMetalGroup(group, col, quality)) continue;
      c.drawImage(
        metal.canvas,
        0,
        0,
        metal.canvas.width,
        metal.canvas.height,
        metal.x * dpr,
        metal.y * dpr,
        metal.w * dpr,
        metal.h * dpr
      );
      metal.empty = false;
    }

    metal.builtVersion = metal.version;
    metal.builtQuality = quality;
  }

  function drawMetalGL(quality = "full") {
    if (silverGL.isLost()) {
      disableGL(new Error("WebGL context lost"));
      return false;
    }
    const stale =
      metal.builtVersion !== metal.version ||
      (quality === "full" && metal.builtQuality !== "full");
    if (stale) {
      try {
        const list = strokesOfKind("silver");
        // Live frames cap resolution (same budget as glass). Full settles at native DPR.
        const maxArea = quality === "live" ? SILVER.liveArea : 0;
        // Glass molding stays on during live erase so metal does not unwrap mid-gesture.
        const glass =
          glassGL && !glassLayer.empty && glassLayer.hasDist
            ? { color: glassLayer.canvas, dist: glassLayer.dist, version: glassLayer.builtVersion }
            : null;

        // Group by metal color (same-color strokes fuse; different colors composite)
        const groups = new Map();
        for (const s of list) {
          if (!groups.has(s.color)) groups.set(s.color, []);
          groups.get(s.color).push(s);
        }

        const c = metalLayerCtx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, metal.layer.width, metal.layer.height);
        c.imageSmoothingEnabled = false; // 1:1 device pixels
        metal.glEmpty = true;
        for (const [colorId, colorGroup] of groups) {
          const col = metalPresetById(colorId);
          const molded = [];
          const onTop = [];
          for (const s of colorGroup) (glass && isOnTop(s) ? onTop : molded).push(s);
          for (const [group, g] of [
            [molded, glass],
            [onTop, null],
          ]) {
            if (group.length === 0) continue;
            const r = silverGL.render(group, {
              ...SILVER,
              maxArea,
              glass: g,
              wrap: WRAP,
              tintLight: col.lightRgb,
              tintDeep: col.deepRgb,
            });
            if (!r) continue;
            c.drawImage(
              silverGL.canvas,
              r.sx,
              r.sy,
              r.sw,
              r.sh,
              r.x * dpr,
              r.y * dpr,
              r.w * dpr,
              r.h * dpr
            );
            metal.glEmpty = false;
          }
        }
      } catch (err) {
        disableGL(err);
        return false;
      }
      metal.builtVersion = metal.version;
      metal.builtQuality = quality;
    }
    if (metal.glEmpty) return true;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(metal.layer, 0, 0);
    ctx.restore();
    return true;
  }

  // Low-res CPU copy of the coarse glass edge distance, read back once per glass build, to
  // tell which silver strokes lie entirely inside a glass piece (those sit on top, unmolded).
  const GLASS_PROBE_SCALE = 0.25;
  const glassProbe = { canvas: document.createElement("canvas"), version: -1, data: null, w: 0, h: 0, s: 1 };
  const glassProbeCtx = glassProbe.canvas.getContext("2d", { willReadFrequently: true });

  /** Signed distance (CSS px, + inside, about +-64) from p to the nearest glass edge. */
  function glassSdAt(x, y) {
    const gp = glassProbe;
    if (gp.version !== glassLayer.builtVersion) {
      gp.w = Math.max(1, Math.round(glassLayer.dist.width * GLASS_PROBE_SCALE));
      gp.h = Math.max(1, Math.round(glassLayer.dist.height * GLASS_PROBE_SCALE));
      gp.canvas.width = gp.w;
      gp.canvas.height = gp.h;
      glassProbeCtx.imageSmoothingEnabled = true;
      glassProbeCtx.drawImage(glassLayer.dist, 0, 0, gp.w, gp.h);
      gp.data = glassProbeCtx.getImageData(0, 0, gp.w, gp.h).data;
      gp.s = gp.w / Math.max(1, width);
      gp.version = glassLayer.builtVersion;
    }
    const px = Math.round(x * gp.s);
    const py = Math.round(y * gp.s);
    if (px < 0 || py < 0 || px >= gp.w || py >= gp.h) return -64;
    return (gp.data[(py * gp.w + px) * 4 + 1] / 255 - 0.5) * 128;
  }

  function isOnTop(s) {
    const pts = s.points;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const key = `${glassLayer.builtVersion}|${pts.length}|${a.x}|${a.y}|${b.x}|${b.y}|${s.width}`;
    if (s._onTop && s._onTop.key === key) return s._onTop.v;
    const need = s.width / 2 + WRAP.lipOverlap + 1;
    let v = true;
    for (const p of pts) {
      if (glassSdAt(p.x, p.y) <= need) {
        v = false;
        break;
      }
    }
    s._onTop = { key, v };
    return v;
  }

  function drawMetal(quality) {
    if (silverGL && drawMetalGL(quality)) {
      stage.dataset.renderer = "webgl";
      return;
    }
    stage.dataset.renderer = "cpu";
    const stale =
      metal.builtVersion !== metal.version ||
      (quality === "full" && metal.builtQuality !== "full");
    if (stale) buildMetal(quality);
    if (metal.empty) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(metal.layer, 0, 0);
    ctx.restore();
  }

  /** Halo behind the selected stroke; drawn at the layer the stroke lives on. */
  function drawSelection(kind) {
    if (tool !== "select" || selectedId == null) return;
    const sel = strokes.find((st) => st.id === selectedId);
    if (!sel || sel.kind !== kind) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(70, 120, 160, 0.45)";
    ctx.fillStyle = "rgba(70, 120, 160, 0.45)";
    ctx.lineWidth = sel.width + 12;
    if (sel.points.length === 1) {
      ctx.beginPath();
      ctx.arc(sel.points[0].x, sel.points[0].y, sel.width / 2 + 6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      strokePolyline(sel.points);
    }
    ctx.restore();
  }

  /** quality "live" = fast, low-res (while drawing / dragging); "full" = settled. */
  function render(quality = "full") {
    drawWorkbench();
    // Layer order: bench, glass, silver (silver sits over the stone)
    drawSelection("glass");
    drawGlass(quality);
    drawSelection("silver");
    drawMetal(quality);
  }

  let rafId = 0;
  let pendingQuality = "live";
  function scheduleRender(quality = "live") {
    if (quality === "full") pendingQuality = "full";
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const q = pendingQuality;
      pendingQuality = "live";
      render(q);
    });
  }

  function appendPoint(p) {
    if (!activeStroke) return;
    const pts = activeStroke.points;
    if (pts.length === 0 || dist(pts[pts.length - 1], p) >= 1.4) {
      pts.push(p);
      // defer silver remold while painting glass; remold once on pointer up
      markDirty(activeStroke.kind, { deferMetal: activeStroke.kind === "glass" });
      scheduleRender("live");
    }
  }

  function deleteSelected() {
    if (selectedId == null) return;
    pushHistory();
    const removed = strokes.find((s) => s.id === selectedId);
    strokes = strokes.filter((s) => s.id !== selectedId);
    selectedId = null;
    syncChrome();
    if (removed) markDirty(removed.kind);
    render();
  }

  const PASTE_OFFSET = 16;

  function cloneStrokeForClipboard(s) {
    return {
      id: s.id,
      kind: s.kind,
      color: s.color,
      width: s.width,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    };
  }

  function pasteStrokeFromData(data, { offsetX = PASTE_OFFSET, offsetY = PASTE_OFFSET } = {}) {
    pushHistory();
    const clone = {
      id: nextStrokeId++,
      kind: data.kind,
      color: data.color,
      width: data.width,
      points: data.points.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })),
    };
    strokes.push(clone);
    selectedId = clone.id;
    syncChrome();
    markDirty(clone.kind);
    render();
    return clone;
  }

  function copySelected() {
    if (tool !== "select" || selectedId == null) return false;
    const s = strokes.find((st) => st.id === selectedId);
    if (!s) return false;
    strokeClipboard = cloneStrokeForClipboard(s);
    return true;
  }

  function pasteClipboard() {
    if (strokeClipboard == null) return false;
    if (tool !== "select") setTool("select");
    pasteStrokeFromData(strokeClipboard);
    return true;
  }

  function duplicateSelected() {
    if (tool !== "select" || selectedId == null) return false;
    const s = strokes.find((st) => st.id === selectedId);
    if (!s) return false;
    pasteStrokeFromData(s);
    return true;
  }

  function clearAll() {
    if (strokes.length === 0 && !activeStroke) return;
    pushHistory();
    strokes = [];
    activeStroke = null;
    selectedId = null;
    drag = null;
    syncChrome();
    markAllDirty();
    render();
  }

  function downloadPng() {
    if (activeStroke || drag) return;

    const prevSelected = selectedId;
    selectedId = null;
    render("full");

    const stamp = new Date().toISOString().slice(0, 10);
    canvas.toBlob((blob) => {
      selectedId = prevSelected;
      render("full");
      syncChrome();
      if (!blob) return;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jewl-${stamp}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    closeLibraries();
    const p = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);

    // Select — pick, drag, and delete any stroke (silver first, then glass).
    if (tool === "select") {
      const hit = hitStrokeAt(p);
      if (hit) {
        selectedId = hit.id;
        drag = {
          kind: "move-stroke",
          start: p,
          origin: {},
          last: p,
          strokeId: hit.id,
          moved: false,
        };
        stage.classList.add("dragging");
        syncChrome();
        render();
        return;
      }

      selectedId = null;
      syncChrome();
      render();
      return;
    }

    // Eraser — punch a Size-scaled circle through strokes; one undo entry per gesture.
    if (tool === "erase") {
      const hadSelection = selectedId != null;
      selectedId = null;
      eraseCursor = p;
      syncEraseCursor();
      drag = { kind: "erase", start: p, origin: {}, last: p, erased: false };
      eraseAt(p);
      if (hadSelection) syncChrome();
      return;
    }

    // Draw paints a new stroke with the active material; it never moves anything
    selectedId = null;
    activeStroke = {
      id: nextStrokeId++,
      kind: material === "glass" ? "glass" : "silver",
      color: material === "glass" ? glassColor : metalPreset,
      points: [p],
      width: thickness,
    };
    drag = { kind: "draw", start: p, origin: {}, last: p };
    syncChrome();
  }

  function onPointerMove(e) {
    const p = pointerPos(e);

    if (tool === "erase") {
      eraseCursor = p;
      syncEraseCursor();
      if (!drag) return;
    }

    if (tool === "select" && !drag) {
      const over = hitStrokeAt(p);
      stage.classList.toggle("over-object", !!over);
    }

    if (!drag) return;

    if (drag.kind === "draw") {
      appendPoint(p);
      drag.last = p;
      return;
    }

    if (drag.kind === "erase") {
      // Same sample spacing as draw so erase feedback keeps pace with painting.
      if (dist(drag.last, p) >= 1.4) {
        eraseAt(p);
        drag.last = p;
      }
      return;
    }

    if (drag.kind === "move-stroke") {
      const dx = p.x - drag.last.x;
      const dy = p.y - drag.last.y;
      if (dx !== 0 || dy !== 0) {
        if (!drag.moved) {
          pushHistory();
          drag.moved = true;
        }
        const stroke = strokes.find((s) => s.id === drag.strokeId);
        if (stroke) {
          for (const pt of stroke.points) {
            pt.x += dx;
            pt.y += dy;
          }
          markDirty(stroke.kind, { deferMetal: stroke.kind === "glass" });
        }
      }
      drag.last = p;
      scheduleRender("live");
    }
  }

  function onPointerUp(e) {
    if (!drag) return;

    if (drag.kind === "draw" && activeStroke) {
      if (activeStroke.points.length >= 2) {
        pushHistory();
        strokes.push(activeStroke);
      }
      // settle: remold silver against the finished glass stroke
      markDirty(activeStroke.kind);
      activeStroke = null;
    } else if (drag.kind === "move-stroke" && drag.moved) {
      const stroke = strokes.find((s) => s.id === drag.strokeId);
      // remold silver once after a glass move (live frames deferred it)
      if (stroke && stroke.kind === "glass") markDirty("glass");
    } else if (drag.kind === "erase" && drag.erased) {
      // Settle at full quality (covers coalesced geometry that skipped live remolds).
      markAllDirty();
    }

    drag = null;
    stage.classList.remove("dragging");
    syncChrome();
    render();

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* already released */
    }
  }

  function onPointerLeave() {
    if (tool !== "erase" || drag) return;
    eraseCursor = null;
    syncEraseCursor();
  }

  // Events
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  thicknessInput.addEventListener("input", () => {
    setThickness(Number(thicknessInput.value));
  });

  thicknessValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitThicknessValue();
      thicknessValue.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      thicknessValue.value = String(thickness);
      thicknessValue.blur();
      closeLibraries();
    }
  });
  thicknessValue.addEventListener("blur", () => {
    commitThicknessValue();
  });
  thicknessValue.addEventListener("pointerdown", (e) => e.stopPropagation());

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  deleteBtn.addEventListener("click", deleteSelected);
  duplicateBtn.addEventListener("click", duplicateSelected);
  clearBtn.addEventListener("click", clearAll);
  downloadBtn.addEventListener("click", downloadPng);

  drawBtn.addEventListener("click", () => setTool("draw"));
  selectBtn.addEventListener("click", () => setTool("select"));
  eraseBtn.addEventListener("click", () => setTool("erase"));

  metalMain.addEventListener("click", () => setMaterial("metal"));
  glassMain.addEventListener("click", () => setMaterial("glass"));
  metalChevron.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLibrary("metal");
  });
  glassChevron.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLibrary("glass");
  });
  sizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSizePanel();
  });
  sizePanel.addEventListener("pointerdown", (e) => e.stopPropagation());

  document.addEventListener("pointerdown", (e) => {
    if (openLibrary == null && colorPickerTarget == null) return;
    if (dock.contains(e.target)) return;
    closeLibraries();
  });

  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable);

    // Exact size field (and any future inputs): don't steal keys for tool shortcuts.
    if (typing) {
      if (!meta && !e.altKey && key === "escape") {
        if (openLibrary != null || colorPickerTarget != null) {
          e.preventDefault();
          closeLibraries();
        }
      }
      return;
    }

    if (meta && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && key === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if ((e.key === "Backspace" || e.key === "Delete") && tool === "select") {
      if (selectedId != null) {
        e.preventDefault();
        deleteSelected();
      }
      return;
    }

    if (meta && key === "c") {
      if (copySelected()) e.preventDefault();
      return;
    }
    if (meta && key === "v") {
      if (pasteClipboard()) e.preventDefault();
      return;
    }
    if (meta && key === "d") {
      if (duplicateSelected()) e.preventDefault();
      return;
    }

    if (!meta && !e.altKey) {
      if (key === "d") setTool("draw");
      if (key === "s" || key === "m") setTool("select");
      if (key === "e") setTool("erase");
      if (key === "g") setMaterial("glass");
      if (key === "escape") {
        if (openLibrary != null || colorPickerTarget != null) {
          closeLibraries();
          return;
        }
        selectedId = null;
        syncChrome();
        render();
      }
    }
  });

  window.addEventListener("resize", resize);

  buildLibraries();
  buildSizePresets();
  sizes.metal = thickness;
  sizes.glass = thickness;
  sizes.eraser = thickness;
  syncSizeUi();
  stage.dataset.tool = tool;
  syncDock();
  syncChrome();
  resize();
})();
