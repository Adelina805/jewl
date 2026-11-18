/*
 * Liquid silver — WebGL2 renderer.
 *
 * Same look as the CPU version in app.js, computed on the GPU:
 *
 *   1. Strokes are drawn as capsules into one mask per weight bucket.
 *   2. Each mask is gaussian-blurred (at reduced resolution for wide blurs).
 *   3. The blurred fields are summed — touching strokes fuse (metaballs).
 *   4. A jump-flood pass gives the distance to the nearest edge, which becomes a
 *      rounded "tube" height profile plus a soft dome and slow ripples.
 *   5. The final pass runs at full device resolution: crisp analytic edge,
 *      normals from the height map, a procedural studio environment reflected
 *      in the surface, and a soft shadow.
 *
 * Exposes window.SilverGL.create(); returns null when WebGL2 + float render
 * targets are unavailable so the caller can fall back to the CPU renderer.
 */
(() => {
  "use strict";

  const MAX_TEXELS = 3800000; // field texture budget (whole canvas)
  const MAX_FIELD_SCALE = 1.5; // field texels per CSS px
  const PAD = 60; // CSS px the metal may extend beyond the canvas
  const SIGMA_REDUCED = 4.5; // wide blurs are done at a resolution where sigma <= this

  // ---------------------------------------------------------------- shaders --
  const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const MASK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner; // x: 0..1 along segment, y: -1 / +1 across
layout(location = 1) in vec4 aSeg;    // ax, ay, bx, by (CSS px)
layout(location = 2) in float aRad;   // half width (CSS px)
uniform vec2 uOrigin;
uniform vec2 uRectCss;
uniform float uPad;
out vec2 vPos;
flat out vec4 vSeg;
flat out float vRad;
void main() {
  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float ext = aRad + uPad;
  vec2 p = a + d * aCorner.x + dir * ((aCorner.x * 2.0 - 1.0) * ext) + n * aCorner.y * ext;
  vPos = p;
  vSeg = aSeg;
  vRad = aRad;
  gl_Position = vec4((p - uOrigin) / uRectCss * 2.0 - 1.0, 0.0, 1.0);
}`;

  const MASK_FS = `#version 300 es
precision highp float;
in vec2 vPos;
flat in vec4 vSeg;
flat in float vRad;
uniform float uAA; // CSS px per texel
out vec4 o;
void main() {
  vec2 a = vSeg.xy;
  vec2 b = vSeg.zw;
  vec2 pa = vPos - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float d = length(pa - ba * h);
  float cov = clamp((vRad - d) / uAA + 0.5, 0.0, 1.0);
  o = vec4(cov, 0.0, 0.0, 1.0);
}`;

  const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uRect;
uniform ivec2 uDir;
uniform float uSigma;
uniform int uRadius;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  float ws = 0.0;
  float k = -0.5 / (uSigma * uSigma);
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = exp(k * float(i * i));
    ws += w;
    ivec2 q = c + uDir * i;
    if (q.x >= 0 && q.y >= 0 && q.x < uRect.x && q.y < uRect.y) {
      acc += w * texelFetch(uSrc, q, 0).r;
    }
  }
  o = vec4(acc / ws, 0.0, 0.0, 1.0);
}`;

  const COMBINE_FS = `#version 300 es
precision highp float;
uniform sampler2D uF0;
uniform sampler2D uF1;
uniform sampler2D uF2;
uniform vec2 uR0;
uniform vec2 uR1;
uniform vec2 uR2;
uniform vec3 uUse;
uniform vec2 uRect;
uniform vec2 uTexSize;
uniform float uThr;
out vec4 o;
vec2 sq(vec2 u, vec2 r) {
  return clamp(u * r, vec2(0.5), r - 0.5) / uTexSize;
}
void main() {
  vec2 u = gl_FragCoord.xy / uRect;
  float F = 0.0;
  if (uUse.x > 0.0) F += texture(uF0, sq(u, uR0)).r;
  if (uUse.y > 0.0) F += texture(uF1, sq(u, uR1)).r;
  if (uUse.z > 0.0) F += texture(uF2, sq(u, uR2)).r;
  float c = smoothstep(uThr - 0.05, uThr + 0.05, F);
  o = vec4(F, c, 0.0, 1.0);
}`;

  // Resample the cover channel into a smaller rect (4-tap box) for wide blurs.
  const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcRect;
uniform vec2 uDstRect;
uniform vec2 uTexSize;
out vec4 o;
void main() {
  vec2 u = gl_FragCoord.xy / uDstRect;
  vec2 p = u * uSrcRect;
  vec2 q = 0.25 * uSrcRect / uDstRect;
  float s = 0.0;
  s += texture(uSrc, clamp(p + vec2(-q.x, -q.y), vec2(0.5), uSrcRect - 0.5) / uTexSize).g;
  s += texture(uSrc, clamp(p + vec2( q.x, -q.y), vec2(0.5), uSrcRect - 0.5) / uTexSize).g;
  s += texture(uSrc, clamp(p + vec2(-q.x,  q.y), vec2(0.5), uSrcRect - 0.5) / uTexSize).g;
  s += texture(uSrc, clamp(p + vec2( q.x,  q.y), vec2(0.5), uSrcRect - 0.5) / uTexSize).g;
  o = vec4(s * 0.25, 0.0, 0.0, 1.0);
}`;

  const JFA_INIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform float uThr;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float F = texelFetch(uComb, c, 0).r;
  o = F < uThr ? vec4(vec2(c), 0.0, 1.0) : vec4(-100000.0, -100000.0, 0.0, 1.0);
}`;

  const JFA_STEP_FS = `#version 300 es
precision highp float;
uniform sampler2D uSeed;
uniform ivec2 uRect;
uniform int uStep;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 cf = vec2(c);
  vec2 best = vec2(-100000.0);
  float bd = 1e20;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = c + ivec2(dx, dy) * uStep;
      if (q.x < 0 || q.y < 0 || q.x >= uRect.x || q.y >= uRect.y) continue;
      vec2 s = texelFetch(uSeed, q, 0).xy;
      if (s.x < 0.0) continue;
      vec2 dv = s - cf;
      float d = dot(dv, dv);
      if (d < bd) { bd = d; best = s; }
    }
  }
  o = vec4(best, 0.0, 1.0);
}`;

  const HEIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uSeed;
uniform sampler2D uDome;
uniform vec2 uDomeRect;
uniform vec2 uTexSize;
uniform vec2 uOriginCss;
uniform vec2 uRectCss;
uniform vec2 uRect;
uniform float uRg;
uniform float uThr;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float F = texelFetch(uComb, c, 0).r;
  if (F < uThr) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 s = texelFetch(uSeed, c, 0).xy;
  float d = s.x < 0.0 ? 1e4 : distance(s, vec2(c));
  float t = clamp(max(d - 0.5, 0.0) / uRg, 0.0, 1.0);
  float u = 1.0 - t;
  vec2 dp = clamp(gl_FragCoord.xy * (uDomeRect / uRect), vec2(0.5), uDomeRect - 0.5);
  float A = texture(uDome, dp / uTexSize).r;
  float pool = A * A;
  vec2 w = uOriginCss + (gl_FragCoord.xy / uRect) * uRectCss;
  float wob = sin(w.x * 0.034 + sin(w.y * 0.021) * 2.1) * cos(w.y * 0.029 + cos(w.x * 0.017) * 1.7);
  float h = uRg * sqrt(max(0.0, 1.0 - u * u)) + uRg * pool * (1.4 + 0.55 * wob);
  o = vec4(h, 0.0, 0.0, 1.0);
}`;

  const FINAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uH;
uniform sampler2D uS;
uniform vec2 uVp;       // viewport size (device px)
uniform vec2 uField;    // field rect (texels)
uniform vec2 uShRect;   // shadow rect (texels)
uniform vec2 uTexSize;
uniform float uThr;
uniform float uFs;      // field texels per CSS px
uniform float uShScale;
out vec4 fragColor;

const vec3 ENV_KEY   = normalize(vec3(-0.5, -0.62, 0.6));
const vec3 ENV_STRIP = normalize(vec3(0.78, -0.3, 0.28));
const vec3 ENV_DARK  = normalize(vec3(0.55, 0.65, 0.3));
const vec3 ENV_DARK2 = normalize(vec3(-0.78, 0.4, 0.22));

float envLum(vec3 r) {
  float rz = r.z;
  float v = rz >= 0.0 ? 0.74 + 0.12 * rz : 0.74 + 0.16 * rz;
  float t = (rz - 0.36) / 0.2;
  v *= 1.0 - 0.82 * exp(-t * t);
  v += (1.0 - v) * smoothstep(0.84, 0.94, dot(r, ENV_KEY));
  v *= 1.0 - 0.88 * smoothstep(0.3, 0.8, dot(r, ENV_DARK));
  v *= 1.0 - 0.7 * smoothstep(0.55, 0.88, dot(r, ENV_DARK2));
  v = max(v, smoothstep(0.975, 0.992, dot(r, ENV_STRIP)));
  return pow(clamp(v, 0.0, 1.0), 1.12);
}

vec2 fq(vec2 f, vec2 r) {
  return clamp(f, vec2(0.5), r - 0.5) / uTexSize;
}
float hAt(vec2 f) {
  return texture(uH, fq(f, uField)).r;
}
float sAt(vec2 f) {
  return texture(uS, fq(f * (uShRect / uField), uShRect)).r;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / uVp.x, 1.0 - gl_FragCoord.y / uVp.y);
  vec2 f = uv * uField;

  float F = texture(uComb, fq(f, uField)).r;
  float fw = max(fwidth(F), 1e-5);
  float c = clamp((F - uThr) / fw + 0.5, 0.0, 1.0);

  vec2 o1 = vec2(1.0, 3.0) * uShScale * uFs;
  vec2 o2 = vec2(0.3, 0.9) * uShScale * uFs;
  float aS = 1.0 - (1.0 - 0.3 * sAt(f - o1)) * (1.0 - 0.3 * sAt(f - o2));
  aS *= 1.0 - c;

  vec3 shadowCol = vec3(28.0, 36.0, 44.0) / 255.0;
  vec3 rgb = shadowCol * aS;
  float alpha = aS;

  if (c > 0.002) {
    float gx = (hAt(f + vec2(1.0, 0.0)) - hAt(f - vec2(1.0, 0.0))) * 0.5;
    float gy = (hAt(f + vec2(0.0, 1.0)) - hAt(f - vec2(0.0, 1.0))) * 0.5;
    float nz = inversesqrt(gx * gx + gy * gy + 1.0);
    float nx = -gx * nz;
    float ny = -gy * nz;
    float v = envLum(vec3(2.0 * nz * nx, 2.0 * nz * ny, 2.0 * nz * nz - 1.0));
    vec3 chrome = min(vec3(18.0, 21.0, 28.0) / 255.0 + vec3(238.0, 239.0, 240.0) / 255.0 * v, vec3(1.0));
    rgb = chrome * c + shadowCol * aS;
    alpha = c + aS;
  }
  fragColor = vec4(rgb, alpha);
}`;

  // ---------------------------------------------------------------- helpers --
  function widthBucket(w) {
    return w < 10 ? 0 : w < 20 ? 1 : 2;
  }

  /** Flatten the same quadratic-through-midpoints curve the canvas path uses. */
  function flatten(points) {
    const out = [];
    const n = points.length;
    if (n === 1) {
      out.push(points[0].x, points[0].y);
      return out;
    }
    let sx = points[0].x;
    let sy = points[0].y;
    out.push(sx, sy);
    for (let i = 1; i < n; i++) {
      const c = points[i - 1];
      const ex = (c.x + points[i].x) / 2;
      const ey = (c.y + points[i].y) / 2;
      const len = Math.hypot(c.x - sx, c.y - sy) + Math.hypot(ex - c.x, ey - c.y);
      const steps = Math.max(1, Math.min(16, Math.ceil(len / 2.5)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const mt = 1 - t;
        out.push(
          mt * mt * sx + 2 * mt * t * c.x + t * t * ex,
          mt * mt * sy + 2 * mt * t * c.y + t * t * ey
        );
      }
      sx = ex;
      sy = ey;
    }
    const last = points[n - 1];
    out.push(last.x, last.y);
    return out;
  }

  function flatOf(stroke) {
    const p = stroke.points;
    const n = p.length;
    const a = p[0];
    const b = p[n - 1];
    const key = `${n}|${a.x}|${a.y}|${b.x}|${b.y}`;
    if (!stroke._flat || stroke._flat.key !== key) {
      stroke._flat = { key, v: flatten(p) };
    }
    return stroke._flat.v;
  }

  function create() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) return null;
    if (!gl.getExtension("EXT_color_buffer_float")) return null;

    let lost = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      lost = true;
    });

    // ---- programs
    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("Shader compile failed: " + gl.getShaderInfoLog(sh));
      }
      return sh;
    }
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("Program link failed: " + gl.getProgramInfoLog(p));
      }
      const cache = {};
      return {
        p,
        u(name) {
          if (!(name in cache)) cache[name] = gl.getUniformLocation(p, name);
          return cache[name];
        },
      };
    }

    let progs;
    try {
      progs = {
        mask: program(MASK_VS, MASK_FS),
        blur: program(FULLSCREEN_VS, BLUR_FS),
        combine: program(FULLSCREEN_VS, COMBINE_FS),
        copy: program(FULLSCREEN_VS, COPY_FS),
        jfaInit: program(FULLSCREEN_VS, JFA_INIT_FS),
        jfaStep: program(FULLSCREEN_VS, JFA_STEP_FS),
        height: program(FULLSCREEN_VS, HEIGHT_FS),
        final: program(FULLSCREEN_VS, FINAL_FS),
      };
    } catch (err) {
      console.warn("[silver-gl]", err);
      return null;
    }

    // ---- geometry
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);

    const buckets = [0, 1, 2].map(() => {
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 20, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);
      return { vao, buf, count: 0 };
    });
    const emptyVao = gl.createVertexArray();

    const fbo = gl.createFramebuffer();

    // ---- textures (allocated for the whole canvas, used through sub-rects)
    let tex = null;
    let capW = 0;
    let capH = 0;
    let fs = 1;
    let curW = 0;
    let curH = 0;
    let curDpr = 1;

    function makeTex(fmt, filter) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, capW, capH);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    function freeTextures() {
      if (!tex) return;
      for (const k of Object.keys(tex)) {
        const v = tex[k];
        if (Array.isArray(v)) v.forEach((t) => gl.deleteTexture(t));
        else gl.deleteTexture(v);
      }
      tex = null;
    }

    function resize(wCss, hCss, dpr) {
      curW = wCss;
      curH = hCss;
      curDpr = dpr;
      const cssW = wCss + PAD * 2;
      const cssH = hCss + PAD * 2;
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      fs = Math.min(dpr, MAX_FIELD_SCALE, Math.sqrt(MAX_TEXELS / (cssW * cssH)));
      fs = Math.min(fs, (maxTex - 4) / Math.max(cssW, cssH));
      const nw = Math.ceil(cssW * fs) + 2;
      const nh = Math.ceil(cssH * fs) + 2;

      const cw = Math.ceil(cssW * dpr);
      const ch = Math.ceil(cssH * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }

      if (tex && nw === capW && nh === capH) return;
      freeTextures();
      capW = nw;
      capH = nh;
      tex = {
        mask: [0, 1, 2].map(() => makeTex(gl.R8, gl.NEAREST)),
        field: [0, 1, 2].map(() => makeTex(gl.R16F, gl.LINEAR)), // later reused: dome, shadow, height
        tmpA: makeTex(gl.R16F, gl.NEAREST),
        tmpB: makeTex(gl.R16F, gl.NEAREST),
        comb: makeTex(gl.RG16F, gl.LINEAR),
        seedA: makeTex(gl.RG32F, gl.NEAREST),
        seedB: makeTex(gl.RG32F, gl.NEAREST),
      };
      // Verify every render-target format actually works on this GPU
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      const check = [tex.mask[0], tex.field[0], tex.comb, tex.seedA];
      for (const t of check) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Float render targets not supported");
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ---- pass helpers
    function target(t, w, h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, w, h);
    }
    function bindTex(unit, t) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    }
    function fullscreen() {
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function blur(src, dst, w, h, dx, dy, sigma) {
      const radius = Math.max(1, Math.min(24, Math.ceil(sigma * 3)));
      target(dst, w, h);
      gl.useProgram(progs.blur.p);
      bindTex(0, src);
      gl.uniform1i(progs.blur.u("uSrc"), 0);
      gl.uniform2i(progs.blur.u("uRect"), w, h);
      gl.uniform2i(progs.blur.u("uDir"), dx, dy);
      gl.uniform1f(progs.blur.u("uSigma"), Math.max(0.3, sigma));
      gl.uniform1i(progs.blur.u("uRadius"), radius);
      fullscreen();
    }
    /** cover channel of the combined field -> blurred single channel at reduced size */
    function coverBlur(dst, gw, gh, sigma) {
      const r = Math.min(1, SIGMA_REDUCED / sigma);
      const dw = Math.max(2, Math.ceil(gw * r));
      const dh = Math.max(2, Math.ceil(gh * r));
      const sig = sigma * (dw / gw);
      target(tex.tmpA, dw, dh);
      gl.useProgram(progs.copy.p);
      bindTex(0, tex.comb);
      gl.uniform1i(progs.copy.u("uSrc"), 0);
      gl.uniform2f(progs.copy.u("uSrcRect"), gw, gh);
      gl.uniform2f(progs.copy.u("uDstRect"), dw, dh);
      gl.uniform2f(progs.copy.u("uTexSize"), capW, capH);
      fullscreen();
      blur(tex.tmpA, tex.tmpB, dw, dh, 1, 0, sig);
      blur(tex.tmpB, dst, dw, dh, 0, 1, sig);
      return { w: dw, h: dh };
    }

    // ---------------------------------------------------------------- render --
    /**
     * @param {{points:{x:number,y:number}[], width:number}[]} strokes
     * @param {{goo:number, threshold:number}} opts
     * @returns {null | {x:number,y:number,w:number,h:number,sx:number,sy:number,sw:number,sh:number}}
     */
    function render(strokes, opts) {
      if (lost || !tex || strokes.length === 0) return null;

      const goo = opts.goo;
      const thr = opts.threshold;

      // --- extents + weights
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxW = 0;
      let sumW = 0;
      const bucketMinW = [Infinity, Infinity, Infinity];
      const bucketSegs = [0, 0, 0];
      const flats = [];
      for (const s of strokes) {
        const v = flatOf(s);
        flats.push(v);
        sumW += s.width;
        maxW = Math.max(maxW, s.width);
        const b = widthBucket(s.width);
        bucketMinW[b] = Math.min(bucketMinW[b], s.width);
        bucketSegs[b] += Math.max(1, v.length / 2 - 1);
        for (const p of s.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const meanW = sumW / strokes.length;
      const margin = maxW * 1.1 + 18;

      // Snap the rect to whole device pixels so the final copy is 1:1
      let unit = 1;
      for (let k = 1; k <= 8; k++) {
        if (Math.abs(k * curDpr - Math.round(k * curDpr)) < 1e-6) {
          unit = k;
          break;
        }
      }
      const x0 = Math.floor(Math.max(minX - margin, -PAD) / unit) * unit;
      const y0 = Math.floor(Math.max(minY - margin, -PAD) / unit) * unit;
      const x1 = Math.ceil(Math.min(maxX + margin, curW + PAD));
      const y1 = Math.ceil(Math.min(maxY + margin, curH + PAD));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;

      const vw = Math.min(canvas.width, Math.ceil((x1 - x0) * curDpr));
      const vh = Math.min(canvas.height, Math.ceil((y1 - y0) * curDpr));
      const rectW = vw / curDpr;
      const rectH = vh / curDpr;
      const gw = Math.max(2, Math.min(capW, Math.round(rectW * fs)));
      const gh = Math.max(2, Math.min(capH, Math.round(rectH * fs)));

      // --- per-bucket instance data
      const data = [0, 1, 2].map((b) => new Float32Array(bucketSegs[b] * 5));
      const fill = [0, 0, 0];
      for (let i = 0; i < strokes.length; i++) {
        const s = strokes[i];
        const v = flats[i];
        const b = widthBucket(s.width);
        const arr = data[b];
        const rad = s.width / 2;
        let o = fill[b];
        if (v.length === 2) {
          arr[o++] = v[0];
          arr[o++] = v[1];
          arr[o++] = v[0];
          arr[o++] = v[1];
          arr[o++] = rad;
        } else {
          for (let k = 2; k < v.length; k += 2) {
            arr[o++] = v[k - 2];
            arr[o++] = v[k - 1];
            arr[o++] = v[k];
            arr[o++] = v[k + 1];
            arr[o++] = rad;
          }
        }
        fill[b] = o;
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      // --- 1+2. masks and per-bucket blur
      const use = [0, 0, 0];
      const rects = [
        [2, 2],
        [2, 2],
        [2, 2],
      ];
      for (let b = 0; b < 3; b++) {
        if (bucketSegs[b] === 0) continue;
        use[b] = 1;
        const sigma0 = goo * bucketMinW[b] * fs;
        const r = Math.min(1, SIGMA_REDUCED / sigma0);
        const bw = Math.max(2, Math.ceil(gw * r));
        const bh = Math.max(2, Math.ceil(gh * r));
        rects[b] = [bw, bh];
        const sigma = sigma0 * (bw / gw);

        target(tex.mask[b], bw, bh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, bw, bh);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);

        gl.useProgram(progs.mask.p);
        gl.uniform2f(progs.mask.u("uOrigin"), x0, y0);
        gl.uniform2f(progs.mask.u("uRectCss"), rectW, rectH);
        const texelCss = rectW / bw;
        gl.uniform1f(progs.mask.u("uAA"), texelCss);
        gl.uniform1f(progs.mask.u("uPad"), texelCss * 2);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        const bk = buckets[b];
        gl.bindVertexArray(bk.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, bk.buf);
        gl.bufferData(gl.ARRAY_BUFFER, data[b], gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bucketSegs[b]);
        gl.disable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);

        blur(tex.mask[b], tex.tmpA, bw, bh, 1, 0, sigma);
        blur(tex.tmpA, tex.field[b], bw, bh, 0, 1, sigma);
      }

      // --- 3. sum the fields -> F and cover
      target(tex.comb, gw, gh);
      gl.useProgram(progs.combine.p);
      bindTex(0, tex.field[0]);
      bindTex(1, tex.field[1]);
      bindTex(2, tex.field[2]);
      gl.uniform1i(progs.combine.u("uF0"), 0);
      gl.uniform1i(progs.combine.u("uF1"), 1);
      gl.uniform1i(progs.combine.u("uF2"), 2);
      gl.uniform2f(progs.combine.u("uR0"), rects[0][0], rects[0][1]);
      gl.uniform2f(progs.combine.u("uR1"), rects[1][0], rects[1][1]);
      gl.uniform2f(progs.combine.u("uR2"), rects[2][0], rects[2][1]);
      gl.uniform3f(progs.combine.u("uUse"), use[0], use[1], use[2]);
      gl.uniform2f(progs.combine.u("uRect"), gw, gh);
      gl.uniform2f(progs.combine.u("uTexSize"), capW, capH);
      gl.uniform1f(progs.combine.u("uThr"), thr);
      fullscreen();

      // --- 4. soft dome (wide blur of cover) and shadow source
      const Rg = Math.max(1.5, 0.5 * meanW * fs);
      const dome = coverBlur(tex.field[0], gw, gh, 1.8 * Rg);
      const shadow = coverBlur(tex.field[1], gw, gh, Math.max(1.2, 0.5 * Rg));

      // --- 5. jump flood: distance from inside texels to the nearest outside texel
      target(tex.seedA, gw, gh);
      gl.useProgram(progs.jfaInit.p);
      bindTex(0, tex.comb);
      gl.uniform1i(progs.jfaInit.u("uComb"), 0);
      gl.uniform1f(progs.jfaInit.u("uThr"), thr);
      fullscreen();

      let src = tex.seedA;
      let dst = tex.seedB;
      let step = 1;
      while (step < Rg + 2) step <<= 1;
      const steps = [];
      for (; step >= 1; step >>= 1) steps.push(step);
      steps.push(1);
      gl.useProgram(progs.jfaStep.p);
      gl.uniform1i(progs.jfaStep.u("uSeed"), 0);
      gl.uniform2i(progs.jfaStep.u("uRect"), gw, gh);
      for (const st of steps) {
        target(dst, gw, gh);
        bindTex(0, src);
        gl.uniform1i(progs.jfaStep.u("uStep"), st);
        fullscreen();
        const t = src;
        src = dst;
        dst = t;
      }
      const seeds = src;

      // --- 6. height map
      target(tex.tmpA, gw, gh);
      gl.useProgram(progs.height.p);
      bindTex(0, tex.comb);
      bindTex(1, seeds);
      bindTex(2, tex.field[0]);
      gl.uniform1i(progs.height.u("uComb"), 0);
      gl.uniform1i(progs.height.u("uSeed"), 1);
      gl.uniform1i(progs.height.u("uDome"), 2);
      gl.uniform2f(progs.height.u("uDomeRect"), dome.w, dome.h);
      gl.uniform2f(progs.height.u("uTexSize"), capW, capH);
      gl.uniform2f(progs.height.u("uOriginCss"), x0, y0);
      gl.uniform2f(progs.height.u("uRectCss"), rectW, rectH);
      gl.uniform2f(progs.height.u("uRect"), gw, gh);
      gl.uniform1f(progs.height.u("uRg"), Rg);
      gl.uniform1f(progs.height.u("uThr"), thr);
      fullscreen();
      // take the stair-steps out of the distance field
      blur(tex.tmpA, tex.tmpB, gw, gh, 1, 0, 1.4);
      blur(tex.tmpB, tex.field[2], gw, gh, 0, 1, 1.4);

      // --- 7. final shading at full device resolution
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vw, vh);
      gl.useProgram(progs.final.p);
      bindTex(0, tex.comb);
      bindTex(1, tex.field[2]);
      bindTex(2, tex.field[1]);
      gl.uniform1i(progs.final.u("uComb"), 0);
      gl.uniform1i(progs.final.u("uH"), 1);
      gl.uniform1i(progs.final.u("uS"), 2);
      gl.uniform2f(progs.final.u("uVp"), vw, vh);
      gl.uniform2f(progs.final.u("uField"), gw, gh);
      gl.uniform2f(progs.final.u("uShRect"), shadow.w, shadow.h);
      gl.uniform2f(progs.final.u("uTexSize"), capW, capH);
      gl.uniform1f(progs.final.u("uThr"), thr);
      gl.uniform1f(progs.final.u("uFs"), fs);
      gl.uniform1f(progs.final.u("uShScale"), Math.min(2, Math.max(0.6, (meanW * 0.5) / 7)));
      fullscreen();

      return {
        x: x0,
        y: y0,
        w: rectW,
        h: rectH,
        sx: 0,
        sy: canvas.height - vh,
        sw: vw,
        sh: vh,
      };
    }

    return { canvas, resize, render, isLost: () => lost };
  }

  window.SilverGL = { create };
})();
