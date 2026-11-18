(() => {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = document.querySelector(".stage");
  const hint = document.getElementById("hint");
  const thicknessInput = document.getElementById("thickness");
  const undoBtn = document.getElementById("undo");
  const redoBtn = document.getElementById("redo");
  const deleteBtn = document.getElementById("delete");
  const clearBtn = document.getElementById("clear");

  /** @typedef {{x:number,y:number}} Pt */
  /** @typedef {{id:number, points: Pt[], width: number}} Stroke */

  /** @type {Stroke[]} */
  let strokes = [];
  /** @type {Stroke | null} */
  let activeStroke = null;
  /** @type {number | null} */
  let selectedId = null;
  let nextStrokeId = 1;

  /** @type {{strokes: Stroke[], selectedId: number|null}[]} */
  let undoStack = [];
  /** @type {{strokes: Stroke[], selectedId: number|null}[]} */
  let redoStack = [];

  let mode = "draw";
  let thickness = Number(thicknessInput.value);
  let dpr = 1;
  let width = 0;
  let height = 0;

  const glass = {
    x: 0,
    y: 0,
    rotation: -0.18,
    scale: 1,
    placed: false,
    userMoved: false,
    outline: buildSeaGlassOutline(),
  };

  /** @type {null | {kind: string, start: Pt, origin: object, last: Pt, strokeId?: number, moved?: boolean}} */
  let drag = null;

  const HINTS = {
    draw: "Draw silver around the glass. Let strokes touch or overlap and they melt into one mass. Switch to Move to reposition anything.",
    move: "Drag any silver stroke or the glass. Drag the handle to rotate the glass. Delete or ⌫ removes a selected stroke.",
  };

  function buildSeaGlassOutline() {
    // Irregular tumbled shard — not a smooth oval
    return [
      { x: -64, y: -6 },
      { x: -56, y: -36 },
      { x: -42, y: -58 },
      { x: -14, y: -70 },
      { x: 18, y: -66 },
      { x: 44, y: -48 },
      { x: 62, y: -22 },
      { x: 68, y: 6 },
      { x: 58, y: 34 },
      { x: 36, y: 54 },
      { x: 8, y: 64 },
      { x: -22, y: 62 },
      { x: -46, y: 42 },
      { x: -60, y: 18 },
    ];
  }

  function cloneStrokes(list) {
    return list.map((s) => ({
      id: s.id,
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
    markMetalDirty();
    render();
  }

  function undo() {
    if (activeStroke) {
      activeStroke = null;
      drag = null;
      markMetalDirty();
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
    deleteBtn.disabled = selectedId == null || mode !== "move";
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
    markMetalDirty();

    // Re-center until the user moves the glass, so full-window resizes stay balanced
    if (!glass.placed || !glass.userMoved) {
      glass.x = width * 0.5;
      glass.y = height * 0.48;
      glass.scale = Math.min(1.15, Math.max(0.85, width / 720));
      glass.placed = true;
    }

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

  function toLocal(p) {
    const dx = p.x - glass.x;
    const dy = p.y - glass.y;
    const c = Math.cos(-glass.rotation);
    const s = Math.sin(-glass.rotation);
    return {
      x: (dx * c - dy * s) / glass.scale,
      y: (dx * s + dy * c) / glass.scale,
    };
  }

  function nearestOnOutline(local) {
    let best = glass.outline[0];
    let bestD = Infinity;
    for (const p of glass.outline) {
      const d = dist(local, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  function pointInGlass(p) {
    const local = toLocal(p);
    const poly = glass.outline;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      const intersect =
        yi > local.y !== yj > local.y &&
        local.x < ((xj - xi) * (local.y - yi)) / (yj - yi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) return true;
    return dist(local, nearestOnOutline(local)) < 14;
  }

  function rotateHandleWorld() {
    const local = { x: 0, y: -98 };
    const c = Math.cos(glass.rotation);
    const s = Math.sin(glass.rotation);
    return {
      x: glass.x + (local.x * c - local.y * s) * glass.scale,
      y: glass.y + (local.x * s + local.y * c) * glass.scale,
    };
  }

  function hitRotateHandle(p) {
    if (mode !== "move") return false;
    return dist(p, rotateHandleWorld()) < 18;
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

  function hitStrokeAt(p) {
    // Topmost stroke first
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const thresh = Math.max(8, s.width * 0.55);
      const pts = s.points;
      if (pts.length === 1 && dist(p, pts[0]) <= thresh) return s;
      for (let j = 1; j < pts.length; j++) {
        if (distToSegment(p, pts[j - 1], pts[j]) <= thresh) return s;
      }
    }
    return null;
  }

  function setMode(next) {
    mode = next;
    stage.dataset.mode = next;
    document.querySelectorAll(".mode").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === next);
    });
    if (next !== "move") {
      selectedId = null;
      stage.classList.remove("over-object");
    }
    hint.textContent = HINTS[next] || HINTS.draw;
    syncChrome();
    render();
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
    metal.glRect = null;
  }

  const metal = {
    glRect: null,
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

  function markMetalDirty() {
    metal.version++;
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

  function buildMetal(quality) {
    const list = activeStroke ? strokes.concat(activeStroke) : strokes;
    if (list.length === 0) {
      metal.builtQuality = quality;
      emptyMetal();
      return;
    }

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
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      metal.builtQuality = quality;
      emptyMetal();
      return;
    }

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

    // --- 6. Shade: normals from the height map, reflect the studio
    if (metal.canvas.width !== gw || metal.canvas.height !== gh) {
      metal.canvas.width = gw;
      metal.canvas.height = gh;
    }
    const img = metalCtx.createImageData(gw, gh);
    const out = img.data;
    const SH_R = 28;
    const SH_G = 36;
    const SH_B = 44;

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

          const cr = Math.min(255, 18 + 238 * v);
          const cg = Math.min(255, 21 + 239 * v);
          const cb = Math.min(255, 28 + 240 * v);

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
    metal.empty = false;
    metal.builtVersion = metal.version;
    metal.builtQuality = quality;
  }

  function drawMetalGL() {
    if (silverGL.isLost()) {
      disableGL(new Error("WebGL context lost"));
      return false;
    }
    if (metal.builtVersion !== metal.version) {
      try {
        const list = activeStroke ? strokes.concat(activeStroke) : strokes;
        metal.glRect = silverGL.render(list, SILVER);
      } catch (err) {
        disableGL(err);
        return false;
      }
      metal.builtVersion = metal.version;
    }
    const r = metal.glRect;
    if (!r) return true;
    ctx.save();
    ctx.imageSmoothingEnabled = false; // 1:1 device pixels
    ctx.drawImage(silverGL.canvas, r.sx, r.sy, r.sw, r.sh, r.x, r.y, r.w, r.h);
    ctx.restore();
    return true;
  }

  function drawMetal(quality) {
    if (silverGL && drawMetalGL()) {
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
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(metal.canvas, metal.x, metal.y, metal.w, metal.h);
    ctx.restore();
  }

  function drawSelection() {
    if (mode !== "move" || selectedId == null) return;
    const sel = strokes.find((st) => st.id === selectedId);
    if (!sel) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Drawn under the silver, so it reads as a halo around the selected piece
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

  function glassPath(c) {
    const pts = glass.outline;
    c.beginPath();
    // Catmull-ish smooth closed curve via midpoints for softer tumbled edges
    const n = pts.length;
    const mid0x = (pts[n - 1].x + pts[0].x) / 2;
    const mid0y = (pts[n - 1].y + pts[0].y) / 2;
    c.moveTo(mid0x, mid0y);
    for (let i = 0; i < n; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % n];
      const midX = (curr.x + next.x) / 2;
      const midY = (curr.y + next.y) / 2;
      c.quadraticCurveTo(curr.x, curr.y, midX, midY);
    }
    c.closePath();
  }

  function drawSeaGlass() {
    ctx.save();
    ctx.translate(glass.x, glass.y);
    ctx.rotate(glass.rotation);
    ctx.scale(glass.scale, glass.scale);

    // Soft diffused shadow
    ctx.save();
    ctx.translate(2.5, 4.5);
    glassPath(ctx);
    ctx.fillStyle = "rgba(40, 55, 65, 0.18)";
    ctx.filter = "blur(2px)";
    ctx.fill();
    ctx.filter = "none";
    ctx.restore();

    // Frosted body
    glassPath(ctx);
    const body = ctx.createLinearGradient(-72, -72, 72, 84);
    body.addColorStop(0, "rgba(190, 230, 222, 0.62)");
    body.addColorStop(0.28, "rgba(110, 185, 178, 0.7)");
    body.addColorStop(0.58, "rgba(58, 138, 142, 0.78)");
    body.addColorStop(0.82, "rgba(72, 150, 148, 0.72)");
    body.addColorStop(1, "rgba(140, 198, 188, 0.58)");
    ctx.fillStyle = body;
    ctx.fill();

    // Soft outer frost halo
    ctx.save();
    glassPath(ctx);
    ctx.clip();
    ctx.globalCompositeOperation = "source-atop";
    ctx.lineWidth = 14;
    ctx.strokeStyle = "rgba(235, 248, 244, 0.55)";
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(210, 235, 228, 0.35)";
    ctx.stroke();
    ctx.restore();

    // Inner depth bloom + mineral flecks
    ctx.save();
    glassPath(ctx);
    ctx.clip();

    const bloom = ctx.createRadialGradient(-16, -20, 2, -4, -6, 78);
    bloom.addColorStop(0, "rgba(245, 255, 250, 0.5)");
    bloom.addColorStop(0.4, "rgba(130, 200, 190, 0.18)");
    bloom.addColorStop(1, "rgba(25, 80, 88, 0.22)");
    ctx.fillStyle = bloom;
    ctx.fillRect(-110, -110, 220, 220);

    // Secondary cool pocket
    const pocket = ctx.createRadialGradient(28, 22, 2, 22, 18, 42);
    pocket.addColorStop(0, "rgba(40, 110, 120, 0.28)");
    pocket.addColorStop(1, "rgba(40, 110, 120, 0)");
    ctx.fillStyle = pocket;
    ctx.fillRect(-110, -110, 220, 220);

    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 22; i++) {
      const fx = Math.sin(i * 2.17) * 38 + Math.cos(i * 0.9) * 10;
      const fy = Math.cos(i * 1.63) * 42;
      ctx.fillStyle = i % 3 === 0 ? "#f0fffa" : "#2a6562";
      ctx.beginPath();
      ctx.ellipse(fx, fy, 1.2 + (i % 3) * 0.35, 0.75, i * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Soft tumbled rim — muted, not a hard outline
    glassPath(ctx);
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = "rgba(220, 238, 232, 0.4)";
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(45, 95, 100, 0.18)";
    ctx.stroke();

    // Specular kiss — soft and small
    ctx.save();
    glassPath(ctx);
    ctx.clip();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.beginPath();
    ctx.ellipse(-18, -30, 16, 7.5, -0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (mode === "move") {
      glassPath(ctx);
      ctx.setLineDash([5 / glass.scale, 5 / glass.scale]);
      ctx.strokeStyle = "rgba(28, 36, 44, 0.38)";
      ctx.lineWidth = 1.1 / glass.scale;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    if (mode === "move") {
      const handle = rotateHandleWorld();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(glass.x, glass.y);
      ctx.lineTo(handle.x, handle.y);
      ctx.strokeStyle = "rgba(28, 36, 44, 0.28)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(handle.x, handle.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.fill();
      ctx.strokeStyle = "rgba(28, 36, 44, 0.55)";
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** quality "live" = fast, low-res metal (while drawing / dragging); "full" = settled. */
  function render(quality = "full") {
    drawWorkbench();
    drawSelection();
    drawMetal(quality);
    drawSeaGlass();
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
      markMetalDirty();
      scheduleRender("live");
    }
  }

  function deleteSelected() {
    if (selectedId == null) return;
    pushHistory();
    strokes = strokes.filter((s) => s.id !== selectedId);
    selectedId = null;
    syncChrome();
    markMetalDirty();
    render();
  }

  function clearAll() {
    if (strokes.length === 0 && !activeStroke) return;
    pushHistory();
    strokes = [];
    activeStroke = null;
    selectedId = null;
    drag = null;
    syncChrome();
    markMetalDirty();
    render();
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const p = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);

    // Move mode — one tool for everything on the canvas.
    // Pick order: rotate handle, then silver (precise, thin targets), then glass.
    if (mode === "move") {
      if (hitRotateHandle(p)) {
        selectedId = null;
        glass.userMoved = true;
        drag = {
          kind: "rotate",
          start: p,
          origin: { rotation: glass.rotation },
          last: p,
        };
        stage.classList.add("dragging");
        syncChrome();
        render();
        return;
      }

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
      if (pointInGlass(p)) {
        glass.userMoved = true;
        drag = {
          kind: "move-glass",
          start: p,
          origin: { x: glass.x, y: glass.y },
          last: p,
        };
        stage.classList.add("dragging");
      }
      syncChrome();
      render();
      return;
    }

    // Draw mode — never moves glass; stroke stays under glass visually
    selectedId = null;
    activeStroke = {
      id: nextStrokeId++,
      points: [p],
      width: thickness,
    };
    drag = { kind: "draw", start: p, origin: {}, last: p };
    syncChrome();
  }

  function onPointerMove(e) {
    const p = pointerPos(e);

    if (mode === "move" && !drag) {
      const over = hitRotateHandle(p) || hitStrokeAt(p) || pointInGlass(p);
      stage.classList.toggle("over-object", !!over);
    }

    if (!drag) return;

    if (drag.kind === "draw") {
      appendPoint(p);
      drag.last = p;
      return;
    }

    if (drag.kind === "move-glass") {
      glass.x = drag.origin.x + (p.x - drag.start.x);
      glass.y = drag.origin.y + (p.y - drag.start.y);
      drag.last = p;
      render("live");
      return;
    }

    if (drag.kind === "rotate") {
      const a0 = Math.atan2(drag.start.y - glass.y, drag.start.x - glass.x);
      const a1 = Math.atan2(p.y - glass.y, p.x - glass.x);
      glass.rotation = drag.origin.rotation + (a1 - a0);
      drag.last = p;
      render("live");
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
          markMetalDirty();
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
      activeStroke = null;
      markMetalDirty();
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

  // Events
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  thicknessInput.addEventListener("input", () => {
    thickness = Number(thicknessInput.value);
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  deleteBtn.addEventListener("click", deleteSelected);
  clearBtn.addEventListener("click", clearAll);

  document.querySelectorAll(".mode").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

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

    if ((e.key === "Backspace" || e.key === "Delete") && mode === "move") {
      if (selectedId != null) {
        e.preventDefault();
        deleteSelected();
      }
      return;
    }

    if (!meta && !e.altKey) {
      if (key === "d" || key === "s") setMode("draw");
      if (key === "m" || key === "e" || key === "p") setMode("move");
      if (key === "escape") {
        selectedId = null;
        syncChrome();
        render();
      }
    }
  });

  window.addEventListener("resize", resize);

  setMode("draw");
  syncChrome();
  resize();
})();
