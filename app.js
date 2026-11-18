(() => {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = document.querySelector(".stage");
  const hint = document.getElementById("hint");
  const thicknessInput = document.getElementById("thickness");
  const undoBtn = document.getElementById("undo");
  const clearBtn = document.getElementById("clear");

  /** @type {{points: {x:number,y:number}[], width: number}[]} */
  let strokes = [];
  /** @type {{points: {x:number,y:number}[], width: number} | null} */
  let activeStroke = null;

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
    selected: false,
    placed: false,
    outline: buildSeaGlassOutline(),
  };

  /** @type {null | {kind: string, start: {x:number,y:number}, origin: object, last: {x:number,y:number}}} */
  let drag = null;

  function buildSeaGlassOutline() {
    return [
      { x: -62, y: -8 },
      { x: -48, y: -52 },
      { x: -8, y: -68 },
      { x: 38, y: -54 },
      { x: 66, y: -18 },
      { x: 58, y: 28 },
      { x: 22, y: 58 },
      { x: -18, y: 64 },
      { x: -54, y: 36 },
    ];
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
    const local = { x: 0, y: -92 };
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

  function setMode(next) {
    mode = next;
    stage.dataset.mode = next;
    document.querySelectorAll(".mode").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === next);
    });
    glass.selected = next === "move";
    hint.textContent =
      next === "draw"
        ? "Draw silver around the glass. Switch to Place to move or rotate."
        : "Drag the glass to place it. Drag the handle to rotate.";
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
    ctx.globalAlpha = 0.04;
    for (let i = 0; i < 140; i++) {
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

  function drawMetallicStroke(stroke) {
    const points = stroke.points;
    const w = stroke.width;
    if (points.length < 2) return;

    const radius = w * 0.5;
    const samples = resample(points, Math.max(0.85, radius * 0.22));

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Contact shadow on the bench
    ctx.save();
    ctx.translate(0.7, 1.7);
    ctx.strokeStyle = "rgba(36, 44, 52, 0.18)";
    ctx.lineWidth = w + 2;
    strokePolyline(points);
    ctx.restore();

    // Tubular metal: overlapping discs with lit radial gradients
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

      // Keep highlight on the lightward side of the tube
      const hx = p.x + nx * radius * -0.28 - radius * 0.12;
      const hy = p.y + ny * radius * -0.28 - radius * 0.22;

      const grad = ctx.createRadialGradient(hx, hy, radius * 0.04, p.x, p.y, radius);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.16, "#f7f9fb");
      grad.addColorStop(0.38, "#d7dee6");
      grad.addColorStop(0.62, "#aeb8c3");
      grad.addColorStop(0.82, "#7f8a96");
      grad.addColorStop(1, "#555e69");

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Soft polish glaze along the lit crest (kept subtle so it stays one wire)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = Math.max(0.6, w * 0.08);
    const thread = samples.map((p) => ({
      x: p.x - radius * 0.18,
      y: p.y - radius * 0.22,
    }));
    strokePolyline(thread);

    ctx.restore();
  }

  function glassPath(c) {
    const pts = glass.outline;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];
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

    // Soft shadow under the stone
    ctx.save();
    ctx.translate(3, 5);
    glassPath(ctx);
    ctx.fillStyle = "rgba(40, 55, 65, 0.22)";
    ctx.fill();
    ctx.restore();

    // Body
    glassPath(ctx);
    const body = ctx.createLinearGradient(-70, -70, 70, 80);
    body.addColorStop(0, "rgba(170, 220, 210, 0.72)");
    body.addColorStop(0.35, "rgba(90, 170, 165, 0.78)");
    body.addColorStop(0.7, "rgba(55, 130, 135, 0.82)");
    body.addColorStop(1, "rgba(120, 185, 175, 0.7)");
    ctx.fillStyle = body;
    ctx.fill();

    // Frosted rim
    ctx.lineWidth = 5.5;
    ctx.strokeStyle = "rgba(220, 240, 235, 0.55)";
    ctx.stroke();

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(40, 90, 95, 0.28)";
    ctx.stroke();

    // Internal color bloom
    ctx.save();
    glassPath(ctx);
    ctx.clip();
    const bloom = ctx.createRadialGradient(-18, -22, 4, -8, -10, 70);
    bloom.addColorStop(0, "rgba(240, 255, 250, 0.55)");
    bloom.addColorStop(0.45, "rgba(120, 200, 190, 0.2)");
    bloom.addColorStop(1, "rgba(30, 90, 100, 0.18)");
    ctx.fillStyle = bloom;
    ctx.fillRect(-100, -100, 200, 200);

    // Tiny mineral flecks
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < 18; i++) {
      const fx = Math.sin(i * 2.1) * 36 + Math.cos(i) * 8;
      const fy = Math.cos(i * 1.7) * 40;
      ctx.fillStyle = i % 3 === 0 ? "#e8fff8" : "#2f6d6a";
      ctx.beginPath();
      ctx.ellipse(fx, fy, 1.4 + (i % 3) * 0.4, 0.9, i, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Specular kiss on the tumbled face
    ctx.save();
    glassPath(ctx);
    ctx.clip();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(-16, -28, 18, 9, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Selection ring in Place mode (still in local glass space)
    if (mode === "move") {
      glassPath(ctx);
      ctx.setLineDash([5 / glass.scale, 5 / glass.scale]);
      ctx.strokeStyle = "rgba(28, 36, 44, 0.4)";
      ctx.lineWidth = 1.15 / glass.scale;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Rotate handle in world space
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
    for (const s of strokes) drawMetallicStroke(s);
    if (activeStroke) drawMetallicStroke(activeStroke);
    drawSeaGlass();
  }

  function appendPoint(p) {
    if (!activeStroke) return;
    const pts = activeStroke.points;
    if (pts.length === 0 || dist(pts[pts.length - 1], p) >= 1.6) {
      pts.push(p);
      render();
    }
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
          kind: "move",
          start: p,
          origin: { x: glass.x, y: glass.y },
          last: p,
        };
        stage.classList.add("dragging");
        return;
      }
      return;
    }

    // Draw mode: clicking glass suggests switching, but still allow drawing nearby
    activeStroke = { points: [p], width: thickness };
    drag = { kind: "draw", start: p, origin: {}, last: p };
  }

  function onPointerMove(e) {
    if (!drag) return;
    const p = pointerPos(e);

    if (drag.kind === "draw") {
      appendPoint(p);
      drag.last = p;
      return;
    }

    if (drag.kind === "move") {
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
    }
  }

  function onPointerUp(e) {
    if (!drag) return;

    if (drag.kind === "draw" && activeStroke) {
      if (activeStroke.points.length >= 2) {
        strokes.push(activeStroke);
      }
      activeStroke = null;
    }

    drag = null;
    stage.classList.remove("dragging");
    render();

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* already released */
    }
  }

  function undo() {
    if (activeStroke) {
      activeStroke = null;
      drag = null;
      render();
      return;
    }
    if (strokes.length === 0) return;
    strokes.pop();
    render();
  }

  function clearAll() {
    strokes = [];
    activeStroke = null;
    drag = null;
    render();
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
  clearBtn.addEventListener("click", clearAll);

  document.querySelectorAll(".mode").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
    if (!meta && e.key.toLowerCase() === "d") setMode("draw");
    if (!meta && e.key.toLowerCase() === "p") setMode("move");
  });

  window.addEventListener("resize", resize);

  setMode("draw");
  resize();
})();
