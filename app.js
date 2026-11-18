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
    outline: buildSeaGlassOutline(),
  };

  /** @type {null | {kind: string, start: Pt, origin: object, last: Pt, strokeId?: number, moved?: boolean}} */
  let drag = null;

  const HINTS = {
    draw: "Draw silver around the glass. Edit moves strokes; Place moves the glass.",
    select: "Click a stroke to select it. Drag to move. Delete or ⌫ removes it.",
    move: "Drag the glass to place it. Drag the handle to rotate.",
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
    render();
  }

  function undo() {
    if (activeStroke) {
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
    deleteBtn.disabled = selectedId == null || mode !== "select";
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

    if (!glass.placed) {
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
    if (next !== "select") {
      selectedId = null;
      stage.classList.remove("over-stroke");
    }
    hint.textContent = HINTS[next] || HINTS.draw;
    syncChrome();
    render();
  }

  function drawWorkbench() {
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, "#d9e2e8");
    g.addColorStop(0.45, "#e7eeef");
    g.addColorStop(1, "#d5dfd9");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.035;
    for (let i = 0; i < 160; i++) {
      const x = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const y = Math.abs(Math.sin(i * 78.233) * 93758.1234) % 1;
      ctx.fillStyle = i % 2 === 0 ? "#1c242c" : "#ffffff";
      ctx.fillRect(x * width, y * height, 1.2, 1.2);
    }
    ctx.restore();

    const vig = ctx.createRadialGradient(
      width * 0.5,
      height * 0.45,
      Math.min(width, height) * 0.2,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.72
    );
    vig.addColorStop(0, "rgba(255,255,255,0)");
    vig.addColorStop(1, "rgba(70, 88, 100, 0.14)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }

  function strokePolyline(points) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const midX = (prev.x + curr.x) / 2;
      const midY = (prev.y + curr.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function resample(points, spacing) {
    if (points.length < 2) return points.slice();
    const out = [points[0]];
    let prev = points[0];
    let budget = 0;
    for (let i = 1; i < points.length; i++) {
      let curr = points[i];
      let seg = dist(prev, curr);
      if (seg < 1e-4) continue;
      while (budget + seg >= spacing) {
        const t = (spacing - budget) / seg;
        const nx = prev.x + (curr.x - prev.x) * t;
        const ny = prev.y + (curr.y - prev.y) * t;
        const p = { x: nx, y: ny };
        out.push(p);
        prev = p;
        seg = dist(prev, curr);
        budget = 0;
      }
      budget += seg;
      prev = curr;
    }
    const last = points[points.length - 1];
    if (dist(out[out.length - 1], last) > 0.5) out.push(last);
    return out;
  }

  function drawMetallicStroke(stroke, opts = {}) {
    const points = stroke.points;
    const w = stroke.width;
    if (points.length < 2) {
      if (points.length === 1) {
        const p = points[0];
        const r = w * 0.5;
        const grad = ctx.createRadialGradient(
          p.x - r * 0.25,
          p.y - r * 0.3,
          r * 0.05,
          p.x,
          p.y,
          r
        );
        grad.addColorStop(0, "#f4f6f8");
        grad.addColorStop(0.45, "#b4bdc7");
        grad.addColorStop(0.78, "#7a848f");
        grad.addColorStop(1, "#4a525c");
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
      return;
    }

    const radius = w * 0.5;
    const samples = resample(points, Math.max(0.9, radius * 0.28));
    const selected = opts.selected;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Soft contact shadow — keeps metal grounded on the bench
    ctx.save();
    ctx.translate(0.6, 1.5);
    ctx.strokeStyle = "rgba(28, 36, 44, 0.16)";
    ctx.lineWidth = w + 1.5;
    strokePolyline(points);
    ctx.restore();

    // Cool shadowed underbelly (gives tubular depth without plastic white)
    ctx.strokeStyle = "rgba(55, 62, 72, 0.55)";
    ctx.lineWidth = w;
    strokePolyline(
      samples.map((p) => ({
        x: p.x + radius * 0.08,
        y: p.y + radius * 0.12,
      }))
    );

    // Body fill via lit discs — cooler midtones, restrained highlight
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(samples.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const nx = -ty;
      const ny = tx;

      const hx = p.x + nx * radius * -0.32 - radius * 0.1;
      const hy = p.y + ny * radius * -0.32 - radius * 0.18;

      const grad = ctx.createRadialGradient(hx, hy, radius * 0.02, p.x, p.y, radius);
      grad.addColorStop(0, "#fbfcfd");
      grad.addColorStop(0.1, "#eef2f5");
      grad.addColorStop(0.28, "#d2dae2");
      grad.addColorStop(0.5, "#aeb8c3");
      grad.addColorStop(0.72, "#87919c");
      grad.addColorStop(0.88, "#5f6771");
      grad.addColorStop(1, "#454c55");

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Narrow specular thread — bright but thin, like brushed wire
    ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = Math.max(0.55, w * 0.065);
    strokePolyline(
      samples.map((p) => ({
        x: p.x - radius * 0.22,
        y: p.y - radius * 0.26,
      }))
    );

    // Soft cooler edge glaze on the dark side
    ctx.strokeStyle = "rgba(40, 48, 58, 0.22)";
    ctx.lineWidth = Math.max(0.5, w * 0.05);
    strokePolyline(
      samples.map((p) => ({
        x: p.x + radius * 0.28,
        y: p.y + radius * 0.3,
      }))
    );

    if (selected) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(28, 36, 44, 0.55)";
      ctx.lineWidth = w + 6;
      strokePolyline(points);
      ctx.setLineDash([]);
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

  function render() {
    drawWorkbench();
    for (const s of strokes) {
      drawMetallicStroke(s, { selected: mode === "select" && s.id === selectedId });
    }
    if (activeStroke) drawMetallicStroke(activeStroke);
    drawSeaGlass();
  }

  function appendPoint(p) {
    if (!activeStroke) return;
    const pts = activeStroke.points;
    if (pts.length === 0 || dist(pts[pts.length - 1], p) >= 1.4) {
      pts.push(p);
      render();
    }
  }

  function deleteSelected() {
    if (selectedId == null) return;
    pushHistory();
    strokes = strokes.filter((s) => s.id !== selectedId);
    selectedId = null;
    syncChrome();
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
    render();
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const p = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);

    if (mode === "move") {
      if (hitRotateHandle(p)) {
        drag = {
          kind: "rotate",
          start: p,
          origin: { rotation: glass.rotation },
          last: p,
        };
        stage.classList.add("dragging");
        return;
      }
      if (pointInGlass(p)) {
        drag = {
          kind: "move-glass",
          start: p,
          origin: { x: glass.x, y: glass.y },
          last: p,
        };
        stage.classList.add("dragging");
        return;
      }
      return;
    }

    if (mode === "select") {
      const hit = hitStrokeAt(p);
      selectedId = hit ? hit.id : null;
      syncChrome();
      render();
      if (hit) {
        drag = {
          kind: "move-stroke",
          start: p,
          origin: {},
          last: p,
          strokeId: hit.id,
          moved: false,
        };
        stage.classList.add("dragging");
      }
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

    if (mode === "select" && !drag) {
      const over = hitStrokeAt(p);
      stage.classList.toggle("over-stroke", !!over);
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
      render();
      return;
    }

    if (drag.kind === "rotate") {
      const a0 = Math.atan2(drag.start.y - glass.y, drag.start.x - glass.x);
      const a1 = Math.atan2(p.y - glass.y, p.x - glass.x);
      glass.rotation = drag.origin.rotation + (a1 - a0);
      drag.last = p;
      render();
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
        }
      }
      drag.last = p;
      render();
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

    if ((e.key === "Backspace" || e.key === "Delete") && mode === "select") {
      if (selectedId != null) {
        e.preventDefault();
        deleteSelected();
      }
      return;
    }

    if (!meta && !e.altKey) {
      if (key === "d" || key === "s") setMode("draw");
      if (key === "e") setMode("select");
      if (key === "p") setMode("move");
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
