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
 * The same pipeline renders two materials, chosen with create(material):
 *   "silver" - chrome reflecting a studio environment; tinted via opts.tintLight / opts.tintDeep
 *   "glass"  - frosted, translucent, tinted sea glass (opts.tintLight / opts.tintDeep)
 *
 * Exposes window.SilverGL.create(material); returns null when WebGL2 + float render
 * targets are unavailable so the caller can fall back to a simple renderer.
 */
(() => {
  "use strict";

  const MAX_TEXELS = 6000000; // field texture budget (whole canvas)
  const MAX_FIELD_SCALE = 2; // field texels per CSS px
  const PAD = 60; // CSS px the metal may extend beyond the canvas
  const SIGMA_REDUCED = 4.5; // wide blurs are done at a resolution where sigma <= this
  const DIST_RANGE = 16; // CSS px: fine glass edge distance is stored in 8 bits over +-this range
  const DIST_COARSE = 64; // CSS px: coarse glass edge distance range (pushing metal out)
  const MOLD_REACH = 60; // CSS px: how far inside the glass metal is pushed back out from

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

  // Resample the cover channel into a smaller rect (4-tap box) for wide blurs. With uUnion
  // the glass counts as cover too, so the dome treats metal + stone as one level mass.
  const copyFS = () => `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcRect;
uniform vec2 uDstRect;
uniform vec2 uTexSize;
uniform float uUnion;
out vec4 o;
${GLASS_FIELD_GLSL}
${FIELD_CSS_GLSL}
float tap(vec2 p) {
  float s = texture(uSrc, clamp(p, vec2(0.5), uSrcRect - 0.5) / uTexSize).g;
  if (uUnion > 0.5) s = max(s, gCov(gSdB(uOriginCss + p / uSrcRect * uRectCss)));
  return s;
}
void main() {
  vec2 u = gl_FragCoord.xy / uDstRect;
  vec2 p = u * uSrcRect;
  vec2 q = 0.25 * uSrcRect / uDstRect;
  float s = tap(p + vec2(-q.x, -q.y)) + tap(p + vec2(q.x, -q.y)) +
            tap(p + vec2(-q.x, q.y)) + tap(p + vec2(q.x, q.y));
  o = vec4(s * 0.25, 0.0, 0.0, 1.0);
}`;

  // Glass edge distance as seen from the silver context. The texture is canvas-sized:
  // R = fine signed distance (+-DIST_RANGE CSS px), G = coarse (+-DIST_COARSE), + inside.
  const GLASS_FIELD_GLSL = `
uniform sampler2D uGD;
uniform float uGlassOn;
uniform vec2 uCanvasCss;
vec2 gTex(vec2 css) { return textureLod(uGD, css / uCanvasCss, 0.0).rg; }
float gSd(vec2 css) { return (gTex(css).r - 0.5) * ${(2 * DIST_RANGE).toFixed(1)}; }
float gSdC(vec2 css) { return (gTex(css).g - 0.5) * ${(2 * DIST_COARSE).toFixed(1)}; }
// fine where it is in range, coarse beyond
float gSdB(vec2 css) {
  vec2 t = gTex(css);
  float f = (t.r - 0.5) * ${(2 * DIST_RANGE).toFixed(1)};
  return abs(f) < ${(DIST_RANGE - 1).toFixed(1)} ? f : (t.g - 0.5) * ${(2 * DIST_COARSE).toFixed(1)};
}
float gCov(float sd) { return smoothstep(-0.75, 0.75, sd); }
// unit direction pointing into the glass
vec2 gDirIn(vec2 css) {
  float e = 3.0;
  vec2 g = vec2(gSdC(css + vec2(e, 0.0)) - gSdC(css - vec2(e, 0.0)),
                gSdC(css + vec2(0.0, e)) - gSdC(css - vec2(0.0, e)));
  float l = length(g);
  return l > 1e-4 ? g / l : vec2(0.0);
}
`;

  // Field passes map a texel to canvas CSS px through the render rect.
  const FIELD_CSS_GLSL = `
uniform vec2 uOriginCss;
uniform vec2 uRectCss;
vec2 fieldCss(vec2 rect) { return uOriginCss + gl_FragCoord.xy / rect * uRectCss; }
`;

  // Glass counts as solid here: texels under the glass are never "outside" seeds, so metal
  // that meets glass keeps its full height up to the contact instead of rolling down.
  const JFA_INIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform float uThr;
uniform vec2 uFieldRect;
out vec4 o;
${GLASS_FIELD_GLSL}
${FIELD_CSS_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float F = texelFetch(uComb, c, 0).r;
  bool outside = F < uThr;
  if (outside && uGlassOn > 0.5 && gSdB(fieldCss(uFieldRect)) > 0.0) outside = false;
  o = outside ? vec4(vec2(c), 0.0, 1.0) : vec4(-100000.0, -100000.0, 0.0, 1.0);
}`;

  // Liquid metal meets glass, step 1 (reduced resolution): for texels in the band just outside
  // the glass edge, walk inward along the glass normal and collect the metal that was drawn
  // inside the glass and whose nearest edge is this one. Deposit it into the band profile,
  // so the displaced metal is (roughly) conserved and piles up against the edge.
  const MOLD_GATHER_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform vec2 uOutRect;
uniform vec2 uField;
uniform vec2 uTexSize;
uniform float uLip;
uniform float uBand;
uniform float uReach;
out vec4 o;
${GLASS_FIELD_GLSL}
${FIELD_CSS_GLSL}
float Fat(vec2 css) {
  vec2 p = clamp((css - uOriginCss) / uRectCss * uField, vec2(0.5), uField - 0.5);
  return texture(uComb, p / uTexSize).r;
}
void main() {
  vec2 css = fieldCss(uOutRect);
  float sd = gSdB(css);
  float x = (sd - (uLip - 0.4 * uBand)) / (0.6 * uBand);
  float b = sd > uLip + 0.75 ? 0.0 : exp(-x * x);
  if (b < 0.01) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 dir = gDirIn(css);
  float t0 = max(uLip - sd, 0.0);
  float dt = uReach / 24.0;
  float M = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec2 p = css + dir * t;
    float s = gSdB(p);
    float inside = smoothstep(uLip - 0.75, uLip + 0.75, s);
    // only metal whose nearest glass edge is this one (no double counting across the stone)
    float mine = smoothstep(-3.0, -1.0, s - (sd + t));
    M += Fat(p) * inside * mine;
  }
  M *= dt;
  o = vec4(M * b / (1.0635 * uBand), 0.0, 0.0, 1.0);
}`;

  // Step 2 (full field resolution): metal cannot enter the glass beyond the lip; the spread
  // deposit is added back along the edge, and metal touching the edge wets along it.
  const moldCombineFS = () => `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uDep;
uniform vec2 uDepRect;
uniform vec2 uField;
uniform float uThr;
uniform float uLip;
uniform float uBand;
uniform float uWet;
uniform float uDisplace;
out vec4 o;
${GLASS_FIELD_GLSL}
${FIELD_CSS_GLSL}
${BSPLINE_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float F = texelFetch(uComb, c, 0).r;
  float sd = gSdB(fieldCss(uField));
  float allowed = 1.0 - smoothstep(uLip - 0.75, uLip + 0.75, sd);
  float dep = max(bs(uDep, gl_FragCoord.xy * (uDepRect / uField), uDepRect), 0.0) * uDisplace;
  float x = (sd - (uLip - 0.4 * uBand)) / (0.6 * uBand);
  float b = exp(-x * x);
  float Fn = min((F + dep + uWet * F * b) * allowed, 4.0);
  o = vec4(Fn, smoothstep(uThr - 0.05, uThr + 0.05, Fn), 0.0, 1.0);
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

  // Cubic B-spline reconstruction (C2 continuous) read straight from texels, so it
  // works on any float format without needing linear filtering. f is in texel
  // units (texel i has its centre at i + 0.5); r is the valid rect in texels.
  const BSPLINE_GLSL = `
vec4 bsW(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(1.0 - 3.0 * t + 3.0 * t2 - t3,
              4.0 - 6.0 * t2 + 3.0 * t3,
              1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3,
              t3) / 6.0;
}
vec4 bsD(float t) {
  float t2 = t * t;
  return vec4(-3.0 + 6.0 * t - 3.0 * t2,
              -12.0 * t + 9.0 * t2,
              3.0 + 6.0 * t - 9.0 * t2,
              3.0 * t2) / 6.0;
}
// value (.x) and d/dx, d/dy (.yz) in texel units
vec3 bsg(sampler2D s, vec2 f, vec2 r) {
  vec2 p = f - 0.5;
  vec2 ip = floor(p);
  vec2 t = p - ip;
  vec4 wx = bsW(t.x);
  vec4 wy = bsW(t.y);
  vec4 dx = bsD(t.x);
  vec4 dy = bsD(t.y);
  ivec2 hi = ivec2(r) - 1;
  ivec2 b = ivec2(ip) - 1;
  float v = 0.0;
  float gx = 0.0;
  float gy = 0.0;
  for (int j = 0; j < 4; j++) {
    int yy = clamp(b.y + j, 0, hi.y);
    float rv = 0.0;
    float rg = 0.0;
    for (int i = 0; i < 4; i++) {
      int xx = clamp(b.x + i, 0, hi.x);
      float tv = texelFetch(s, ivec2(xx, yy), 0).r;
      rv += tv * wx[i];
      rg += tv * dx[i];
    }
    v += rv * wy[j];
    gx += rg * wy[j];
    gy += rv * dy[j];
  }
  return vec3(v, gx, gy);
}
float bs(sampler2D s, vec2 f, vec2 r) {
  vec2 p = f - 0.5;
  vec2 ip = floor(p);
  vec2 t = p - ip;
  vec4 wx = bsW(t.x);
  vec4 wy = bsW(t.y);
  ivec2 hi = ivec2(r) - 1;
  ivec2 b = ivec2(ip) - 1;
  float v = 0.0;
  for (int j = 0; j < 4; j++) {
    int yy = clamp(b.y + j, 0, hi.y);
    float rv = 0.0;
    for (int i = 0; i < 4; i++) {
      int xx = clamp(b.x + i, 0, hi.x);
      rv += texelFetch(s, ivec2(xx, yy), 0).r * wx[i];
    }
    v += rv * wy[j];
  }
  return v;
}
`;

  const HEIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uSeed;
uniform sampler2D uDome;
uniform vec2 uDomeRect;
uniform vec2 uRect;
uniform float uRg;
uniform float uThr;
uniform float uDomeK;
uniform float uFlatR;   // CSS px: how far from the glass the metal flattens
out vec4 o;
${BSPLINE_GLSL}
${GLASS_FIELD_GLSL}
${FIELD_CSS_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float F = texelFetch(uComb, c, 0).r;
  if (F < uThr) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // near glass the metal becomes a flat, bezel-like strip so it sits level with the stone
  float near = 0.0;
  if (uGlassOn > 0.5) near = 1.0 - smoothstep(0.0, uFlatR, -gSdC(fieldCss(uRect)));
  float rg = uRg * mix(1.0, 0.35, near);
  vec2 s = texelFetch(uSeed, c, 0).xy;
  float d = s.x < 0.0 ? 1e4 : distance(s, vec2(c));
  float t = clamp(max(d - 0.5, 0.0) / rg, 0.0, 1.0);
  float u = 1.0 - t;
  // C2 upsample of the low-res dome so large masses stay perfectly smooth
  float A = clamp(bs(uDome, gl_FragCoord.xy * (uDomeRect / uRect), uDomeRect), 0.0, 1.0);
  float pool = smoothstep(0.0, 1.0, A);
  // rounded tube profile (tiny epsilon keeps the slope finite at the rim) + smooth pillow dome
  float tube = sqrt(max(0.0, 1.0 - u * u) + 1e-3) - 0.031622777;
  float h = uRg * tube + uRg * pool * uDomeK;
  o = vec4(h, 0.0, 0.0, 1.0);
}`;

  // The final pass is shared; each material supplies extra GLSL (uniforms/functions,
  // including thrAt(), the field level of the surface edge) and a shading block that
  // sets premultiplied `rgb` and `alpha` for texels inside the surface.
  // Hooks every material provides (the shared final pass calls them):
  //   shadowKeep(css)                  how much of the bench drop shadow survives at this pixel
  //   adjustGrad(hg, css, se, ng)      bends the height gradient (metal draping over the glass)
  //   outsideShade(...)                extra shading just outside the surface edge
  // se is the signed distance (CSS px, + inside) from the pixel to this material's edge, and
  // ng the unit direction pointing into the surface. css is the pixel in canvas CSS px.
  const NO_HOOKS = `
float shadowKeep(vec2 css) { return 1.0; }
vec3 adjustGrad(vec3 hg, vec2 css, float se, vec2 ng) { return hg; }
void outsideShade(inout vec3 rgb, inout float alpha, float aS, float se, float c, vec2 css, vec3 shadowCol) {}
`;

  // Silver reads the finished glass layer (colour + signed edge distance, both canvas-sized
  // textures uploaded from 2D canvases). The mold passes have already shaped the metal around
  // the glass; here it only gets a thin bevel and seam at the contact, and the glass right
  // next to the metal is flattened so the two read as one level.
  const SILVER_EXTRA = `
uniform sampler2D uGC;      // glass colour layer (unpremultiplied RGBA)
uniform float uTint;        // glass colour picked up right at the contact edge
uniform float uSeam;
uniform float uBevel;       // slope of the narrow bevel where metal meets glass
uniform float uBevW;        // CSS px
uniform float uFlatG;       // how much of the glass's frosted edge is hidden next to metal
uniform float uFlatW;       // CSS px
uniform vec3 uMetalLight;   // chrome highlight tint
uniform vec3 uMetalDeep;    // chrome recess tint
${GLASS_FIELD_GLSL}

float thrAt(vec2 f) { return uThr; }

// 1 when the nearest metal edge to this pixel is up against glass
float contactAt(vec2 css, float se, vec2 ng) {
  return gCov(gSd(css - ng * (max(se, 0.0) + 1.0)));
}

float shadowKeep(vec2 css) {
  if (uGlassOn < 0.5) return 1.0;
  return 1.0 - gCov(gSd(css));
}

// Narrow bevel along the contact: the surface tips toward the glass over the last px.
vec3 adjustGrad(vec3 hg, vec2 css, float se, vec2 ng) {
  if (uGlassOn < 0.5 || se < 0.0 || se > uBevW * 1.5) return hg;
  float k = contactAt(css, se, ng);
  if (k < 0.002) return hg;
  float slope = uBevel * k * (1.0 - smoothstep(0.0, uBevW, se));
  return vec3(hg.x, hg.y + ng.x * slope, hg.z + ng.y * slope);
}

// Thin dark seam and a hint of glass colour, only within ~2 px of the contact. The metal
// itself stays opaque chrome.
vec3 wrapChrome(vec3 chrome, float se, vec2 css, vec2 ng) {
  if (uGlassOn < 0.5 || se > 3.0) return chrome;
  float k = contactAt(css, se, ng);
  if (k < 0.002) return chrome;
  vec4 gcol = textureLod(uGC, (css - ng * (max(se, 0.0) + 3.0)) / uCanvasCss, 0.0);
  float amt = uTint * k * gcol.a * (1.0 - smoothstep(0.0, 2.0, se));
  chrome = mix(chrome, chrome * 0.6 + gcol.rgb * 0.4, amt);
  chrome *= 1.0 - uSeam * k * (1.0 - smoothstep(0.0, 1.1, se));
  return chrome;
}

// Glass side of the contact: hide the glass's rounded, frosted edge right next to the metal
// by painting the glass colour from further inside (over an approximate bench colour), then
// a thin seam line. All contributions are weighted by (1 - c), the part of the pixel that is
// not metal.
void outsideShade(inout vec3 rgb, inout float alpha, float aS, float se, float c, vec2 css, vec3 shadowCol) {
  if (uGlassOn < 0.5) return;
  float gc = gCov(gSd(css));
  if (gc < 0.002) return;
  float ce = max(-se, 0.0);
  if (ce > uFlatW) return;
  float w = 1.0 - c;
  vec4 gcol = textureLod(uGC, (css + gDirIn(css) * uFlatW * 1.2) / uCanvasCss, 0.0);
  vec3 bench = vec3(0.93, 0.95, 0.95);
  vec3 inner = gcol.rgb * gcol.a + bench * (1.0 - gcol.a);
  float a = uFlatG * gc * (1.0 - smoothstep(0.5 * uFlatW, uFlatW, ce)) * w;
  rgb = inner * a + rgb * (1.0 - a);
  alpha = a + alpha * (1.0 - a);
  float s = uSeam * 0.7 * gc * (1.0 - smoothstep(0.2, 1.3, ce)) * w;
  rgb = shadowCol * s + rgb * (1.0 - s);
  alpha = s + alpha * (1.0 - s);
}
`;

  // rgb / alpha arrive holding the outside part of the pixel (shadow, contact shading), already
  // weighted by (1 - c); the opaque chrome fills the rest.
  const SILVER_SHADE = `
    float v = envLum(vec3(2.0 * nz * nx, 2.0 * nz * ny, 2.0 * nz * nz - 1.0));
    // Deep recess + bright highlight, same HDR shape as sterling but metal-tinted
    vec3 chrome = min(uMetalDeep * 0.15 + uMetalLight * v, vec3(1.0));
    chrome = wrapChrome(chrome, se, css, ng);
    rgb = chrome * c + rgb;
    alpha = c + alpha;
`;

  // Frosted, translucent sea glass: tinted body that deepens with thickness, a lighter
  // frosted rim, broad matte highlights, fine grain, and a gently wobbling edge.
  const GLASS_NOISE = `
uniform float uHs;        // height scale (texels): the tube radius
uniform vec3 uTintLight;
uniform vec3 uTintDeep;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float thrAt(vec2 f) {
  vec2 w = f / uFs / 34.0;
  float n = vnoise(w) * 0.8 + vnoise(w * 1.9 + 7.1) * 0.2;
  return uThr + (n - 0.5) * 0.08;
}
`;
  const GLASS_EXTRA = GLASS_NOISE + NO_HOOKS;

  const GLASS_SHADE = `
    float tubeT = clamp(hg.x / max(uHs, 1.0), 0.0, 1.0);
    // the glass dome is flat (flush with the metal), so the plateau is ~1.4 tube radii tall
    float depth = clamp(hg.x / (max(uHs, 1.0) * 1.6), 0.0, 1.0);
    float frost = 1.0 - smoothstep(0.0, 0.75, tubeT);
    vec3 n = vec3(nx, ny, nz);
    vec3 L = normalize(vec3(-0.5, -0.62, 0.6));
    float diff = dot(n, L);
    vec3 body = mix(uTintLight, uTintDeep, smoothstep(0.1, 0.9, depth));
    body *= 0.88 + 0.22 * diff;
    vec3 frostCol = mix(uTintLight, vec3(0.96, 0.985, 0.98), 0.7);
    body = mix(body, frostCol, 0.18 + frost * 0.55);
    vec3 Hh = normalize(L + vec3(0.0, 0.0, 1.0));
    float nh = max(dot(n, Hh), 0.0);
    float spec = pow(nh, 14.0) * 0.16 + pow(nh, 70.0) * 0.05;
    float grain = (hash12(gl_FragCoord.xy) - 0.5) * 0.06;
    body += spec + grain;
    float ga = mix(0.52, 0.84, smoothstep(0.0, 0.8, depth)) + frost * 0.08;
    ga = clamp(max(ga, spec * 1.5), 0.0, 0.94);
    vec3 col = clamp(body, 0.0, 1.0);
    rgb = col * ga * c + shadowCol * aS;
    alpha = ga * c + aS;
`;

  const finalFS = (extra, shade) => `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uH;
uniform sampler2D uS;
uniform vec2 uVp;       // viewport size (device px)
uniform vec2 uField;    // field rect (texels)
uniform vec2 uShRect;   // shadow rect (texels)
uniform float uThr;
uniform float uFs;      // field texels per CSS px
uniform float uShScale;
uniform vec2 uOriginCss; // CSS px position of this render rect on the canvas
uniform vec2 uRectCss;   // CSS px size of this render rect
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

${BSPLINE_GLSL}
float sAt(vec2 f) {
  return bs(uS, f * (uShRect / uField), uShRect);
}
${extra}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / uVp.x, 1.0 - gl_FragCoord.y / uVp.y);
  vec2 f = uv * uField;
  vec2 css = uOriginCss + uv * uRectCss;

  vec3 Fg = bsg(uComb, f, uField);
  float F = Fg.x;
  float thr = thrAt(f);
  float fw = max(fwidth(F), 1e-5);
  float c = clamp((F - thr) / fw + 0.5, 0.0, 1.0);
  // first-order signed distance to this material's edge (CSS px, + inside) and the
  // direction into the surface; only the contact effects use them
  float fgl = length(Fg.yz);
  float se = clamp((F - thr) / max(fgl, 1e-4) / uFs, -64.0, 64.0);
  vec2 ng = fgl > 1e-4 ? Fg.yz / fgl : vec2(0.0);

  float aS = 0.0;
  if (c < 0.999) {
    vec2 o1 = vec2(1.0, 3.0) * uShScale * uFs;
    vec2 o2 = vec2(0.3, 0.9) * uShScale * uFs;
    aS = 1.0 - (1.0 - 0.3 * sAt(f - o1)) * (1.0 - 0.3 * sAt(f - o2));
    aS *= 1.0 - c;
    aS *= shadowKeep(css);
  }

  vec3 shadowCol = vec3(28.0, 36.0, 44.0) / 255.0;
  vec3 rgb = shadowCol * aS;
  float alpha = aS;
  if (c < 0.999) outsideShade(rgb, alpha, aS, se, c, css, shadowCol);

  if (c > 0.002) {
    // height and its gradient from one C2 cubic reconstruction: continuous normals
    vec3 hg = adjustGrad(bsg(uH, f, uField), css, se, ng);
    float gx = hg.y;
    float gy = hg.z;
    float nz = inversesqrt(gx * gx + gy * gy + 1.0);
    float nx = -gx * nz;
    float ny = -gy * nz;
    ${shade}
  }
  fragColor = vec4(rgb, alpha);
}`;

  const FINAL_FS = {
    silver: finalFS(SILVER_EXTRA, SILVER_SHADE),
    glass: finalFS(GLASS_EXTRA, GLASS_SHADE),
  };

  // Glass only: the signed distance to the (wobbling) glass edge for the silver pass to read.
  // R = fine (+-DIST_RANGE CSS px), G = coarse (+-DIST_COARSE); 0.5 is the edge, inside is
  // above. Near the edge it is a first-order estimate from the field; deeper inside, where the
  // field flattens out, the jump-flood distance is used instead.
  const GLASS_DIST_FS = `#version 300 es
precision highp float;
uniform sampler2D uComb;
uniform sampler2D uSeed;
uniform vec2 uVp;
uniform vec2 uField;
uniform float uThr;
uniform float uFs;
out vec4 fragColor;
${BSPLINE_GLSL}
${GLASS_NOISE}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / uVp.x, 1.0 - gl_FragCoord.y / uVp.y);
  vec2 f = uv * uField;
  vec3 Fg = bsg(uComb, f, uField);
  float sd = (Fg.x - thrAt(f)) / max(length(Fg.yz), 1e-4) / uFs;
  if (sd > 6.0) {
    vec2 s = texelFetch(uSeed, ivec2(f), 0).xy;
    if (s.x >= 0.0) sd = max(6.0, distance(s, floor(f)) / uFs);
  }
  float fine = clamp(0.5 + sd / ${(2 * DIST_RANGE).toFixed(1)}, 0.0, 1.0);
  float coarse = clamp(0.5 + sd / ${(2 * DIST_COARSE).toFixed(1)}, 0.0, 1.0);
  fragColor = vec4(fine, coarse, 0.0, 1.0);
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

  function create(material = "silver") {
    if (!FINAL_FS[material]) material = "silver";
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
      if (type === gl.FRAGMENT_SHADER) {
        // fragment samplers default to lowp, which can truncate float lookups on some GPUs
        src = src.replace("precision highp float;", "precision highp float;\nprecision highp int;\nprecision highp sampler2D;");
      }
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
        copy: program(FULLSCREEN_VS, copyFS()),
        jfaInit: program(FULLSCREEN_VS, JFA_INIT_FS),
        jfaStep: program(FULLSCREEN_VS, JFA_STEP_FS),
        height: program(FULLSCREEN_VS, HEIGHT_FS),
        final: program(FULLSCREEN_VS, FINAL_FS[material]),
      };
      if (material === "glass") progs.dist = program(FULLSCREEN_VS, GLASS_DIST_FS);
      if (material === "silver") {
        progs.moldGather = program(FULLSCREEN_VS, MOLD_GATHER_FS);
        progs.moldCombine = program(FULLSCREEN_VS, moldCombineFS());
      }
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
      lastPass = null;
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
        // full 32-bit floats: the height map feeds the surface normals, and half floats
        // would quantize it into visible terraces
        tmpA: makeTex(gl.R32F, gl.NEAREST),
        tmpB: makeTex(gl.R32F, gl.NEAREST),
        height: makeTex(gl.R32F, gl.NEAREST),
        comb: makeTex(gl.RG16F, gl.LINEAR),
        comb2: makeTex(gl.RG16F, gl.LINEAR), // molded field (swapped with comb)
        seedA: makeTex(gl.RG32F, gl.NEAREST),
        seedB: makeTex(gl.RG32F, gl.NEAREST),
      };
      // Verify every render-target format actually works on this GPU
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      const check = [tex.mask[0], tex.field[0], tex.comb, tex.seedA, tex.tmpA, tex.height];
      for (const t of check) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Float render targets not supported");
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ---- glass layer textures (silver only): colour + signed edge distance, uploaded from
    // the canvas-sized 2D canvases the app composites the glass into
    let lastPass = null;
    let glassTex = null;
    let glassVer = null;
    let glassSize = "";
    // uploads use a scratch unit so they never disturb the bindings of a pass in progress
    const SCRATCH_UNIT = 7;
    function makeGlassTex() {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    }
    /** Make sure the glass textures match opts.glass; returns false when there is no glass. */
    function syncGlass(g) {
      if (!g || !g.color || !g.dist || !g.color.width || !g.color.height) return false;
      if (!glassTex) glassTex = [makeGlassTex(), makeGlassTex()];
      const size = `${g.color.width}x${g.color.height}`;
      if (glassVer !== g.version || glassSize !== size) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
        [g.color, g.dist].forEach((src, i) => {
          gl.bindTexture(gl.TEXTURE_2D, glassTex[i]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        });
        glassVer = g.version;
        glassSize = size;
      }
      return true;
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
    function coverBlur(dst, gw, gh, sigma, union = null) {
      const r = Math.min(1, SIGMA_REDUCED / sigma);
      const dw = Math.max(2, Math.ceil(gw * r));
      const dh = Math.max(2, Math.ceil(gh * r));
      const sig = sigma * (dw / gw);
      target(tex.tmpA, dw, dh);
      gl.useProgram(progs.copy.p);
      bindTex(0, tex.comb);
      gl.uniform1i(progs.copy.u("uSrc"), 0);
      gl.uniform1f(progs.copy.u("uUnion"), union ? 1 : 0);
      if (union) union(progs.copy);
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
     * @param {{goo:number, threshold:number, maxArea?: number}} opts
     * @returns {null | {x:number,y:number,w:number,h:number,sx:number,sy:number,sw:number,sh:number}}
     */
    function render(strokes, opts) {
      lastPass = null;
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
      const wrap = opts.wrap || {};
      const knob = (k, d) => (wrap[k] != null ? wrap[k] : d);
      // silver touching glass: the glass layer molds the metal (see MOLD_* shaders)
      const hasGlass = material === "silver" && syncGlass(opts.glass);
      // pushed-out metal can land up to MOLD_REACH px from where it was drawn
      const margin = maxW * 1.1 + 18 + (hasGlass ? MOLD_REACH : 0);

      // Snap the rect to whole device pixels so the final copy is 1:1 at full quality.
      // When opts.maxArea caps resolution (live drawing), skip the snap — the blit upscales.
      let unit = 1;
      const maxArea = opts.maxArea > 0 ? opts.maxArea : 0;
      if (!maxArea) {
        for (let k = 1; k <= 8; k++) {
          if (Math.abs(k * curDpr - Math.round(k * curDpr)) < 1e-6) {
            unit = k;
            break;
          }
        }
      }
      const x0 = Math.floor(Math.max(minX - margin, -PAD) / unit) * unit;
      const y0 = Math.floor(Math.max(minY - margin, -PAD) / unit) * unit;
      const x1 = Math.ceil(Math.min(maxX + margin, curW + PAD));
      const y1 = Math.ceil(Math.min(maxY + margin, curH + PAD));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;

      // CSS rect stays full-size for positioning; pixelScale may drop under maxArea.
      const rectW = x1 - x0;
      const rectH = y1 - y0;
      let pixelScale = curDpr;
      if (maxArea) {
        const fullArea = rectW * rectH * curDpr * curDpr;
        if (fullArea > maxArea) pixelScale = curDpr * Math.sqrt(maxArea / fullArea);
      }
      const vw = Math.min(canvas.width, Math.max(2, Math.ceil(rectW * pixelScale)));
      const vh = Math.min(canvas.height, Math.max(2, Math.ceil(rectH * pixelScale)));
      const fieldScale = fs * (pixelScale / curDpr);
      const gw = Math.max(2, Math.min(capW, Math.round(rectW * fieldScale)));
      const gh = Math.max(2, Math.min(capH, Math.round(rectH * fieldScale)));

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
        const sigma0 = goo * bucketMinW[b] * fieldScale;
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

      // glass edge distance on unit 4 (colour on 3) for every pass that reads it
      if (material === "silver") {
        if (!glassTex) glassTex = [makeGlassTex(), makeGlassTex()];
        bindTex(3, glassTex[0]);
        bindTex(4, glassTex[1]);
      }
      const glassU = (prog) => {
        gl.uniform1f(prog.u("uGlassOn"), hasGlass ? 1 : 0);
        gl.uniform1i(prog.u("uGD"), 4);
        gl.uniform2f(prog.u("uCanvasCss"), curW, curH);
        gl.uniform2f(prog.u("uOriginCss"), x0, y0);
        gl.uniform2f(prog.u("uRectCss"), rectW, rectH);
      };

      // --- 3b. liquid metal meets glass: push metal out of the stone and pile it on the edge
      if (hasGlass) {
        const lip = knob("lipOverlap", 1.5);
        const band = Math.min(14, Math.max(3, knob("bandWidth", 0.35) * meanW));
        const spread = Math.min(24, Math.max(3, 0.6 * meanW)) * fieldScale; // texels
        const r = Math.min(1, Math.max(SIGMA_REDUCED / spread, 1.5 / (band * fieldScale)));
        const dw = Math.max(2, Math.ceil(gw * r));
        const dh = Math.max(2, Math.ceil(gh * r));

        target(tex.tmpA, dw, dh);
        const pg = progs.moldGather;
        gl.useProgram(pg.p);
        bindTex(0, tex.comb);
        gl.uniform1i(pg.u("uComb"), 0);
        gl.uniform2f(pg.u("uOutRect"), dw, dh);
        gl.uniform2f(pg.u("uField"), gw, gh);
        gl.uniform2f(pg.u("uTexSize"), capW, capH);
        gl.uniform1f(pg.u("uLip"), lip);
        gl.uniform1f(pg.u("uBand"), band);
        gl.uniform1f(pg.u("uReach"), MOLD_REACH);
        glassU(pg);
        fullscreen();
        // spread the deposit along the edge, like liquid levelling out
        const sig = spread * (dw / gw);
        blur(tex.tmpA, tex.tmpB, dw, dh, 1, 0, sig);
        blur(tex.tmpB, tex.tmpA, dw, dh, 0, 1, sig);

        target(tex.comb2, gw, gh);
        const pc = progs.moldCombine;
        gl.useProgram(pc.p);
        bindTex(0, tex.comb);
        bindTex(1, tex.tmpA);
        gl.uniform1i(pc.u("uComb"), 0);
        gl.uniform1i(pc.u("uDep"), 1);
        gl.uniform2f(pc.u("uDepRect"), dw, dh);
        gl.uniform2f(pc.u("uField"), gw, gh);
        gl.uniform1f(pc.u("uThr"), thr);
        gl.uniform1f(pc.u("uLip"), lip);
        gl.uniform1f(pc.u("uBand"), band);
        gl.uniform1f(pc.u("uWet"), knob("wet", 0.6));
        gl.uniform1f(pc.u("uDisplace"), knob("displace", 1.0));
        glassU(pc);
        fullscreen();
        const t = tex.comb;
        tex.comb = tex.comb2;
        tex.comb2 = t;
      }

      // --- 4. soft dome (wide blur of cover) and shadow source
      const Rg = Math.max(1.5, 0.5 * meanW * fieldScale);
      const dome = coverBlur(tex.field[0], gw, gh, 1.8 * Rg, hasGlass ? glassU : null);
      const shadow = coverBlur(tex.field[1], gw, gh, Math.max(1.2, 0.5 * Rg));

      // --- 5. jump flood: distance from inside texels to the nearest outside texel
      target(tex.seedA, gw, gh);
      gl.useProgram(progs.jfaInit.p);
      bindTex(0, tex.comb);
      gl.uniform1i(progs.jfaInit.u("uComb"), 0);
      gl.uniform1f(progs.jfaInit.u("uThr"), thr);
      gl.uniform2f(progs.jfaInit.u("uFieldRect"), gw, gh);
      if (material === "silver") glassU(progs.jfaInit);
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
      gl.uniform2f(progs.height.u("uRect"), gw, gh);
      gl.uniform1f(progs.height.u("uRg"), Rg);
      gl.uniform1f(progs.height.u("uThr"), thr);
      gl.uniform1f(progs.height.u("uDomeK"), opts.domeK != null ? opts.domeK : 1.4);
      gl.uniform1f(progs.height.u("uFlatR"), Math.min(20, Math.max(6, 1.5 * meanW)));
      if (material === "silver") glassU(progs.height);
      fullscreen();
      // take the stair-steps and medial-axis creases out of the distance field
      const hSigma = Math.min(4, Math.max(1.4, 0.12 * Rg));
      blur(tex.tmpA, tex.tmpB, gw, gh, 1, 0, hSigma);
      blur(tex.tmpB, tex.height, gw, gh, 0, 1, hSigma);

      // --- 7. final shading at full device resolution
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vw, vh);
      gl.useProgram(progs.final.p);
      bindTex(0, tex.comb);
      bindTex(1, tex.height);
      bindTex(2, tex.field[1]);
      gl.uniform1i(progs.final.u("uComb"), 0);
      gl.uniform1i(progs.final.u("uH"), 1);
      gl.uniform1i(progs.final.u("uS"), 2);
      gl.uniform2f(progs.final.u("uVp"), vw, vh);
      gl.uniform2f(progs.final.u("uField"), gw, gh);
      gl.uniform2f(progs.final.u("uShRect"), shadow.w, shadow.h);
      gl.uniform1f(progs.final.u("uThr"), thr);
      if (material === "glass") {
        const tl = opts.tintLight || [0.6, 0.85, 0.82];
        const td = opts.tintDeep || [0.2, 0.5, 0.52];
        gl.uniform1f(progs.final.u("uHs"), Rg);
        gl.uniform3f(progs.final.u("uTintLight"), tl[0], tl[1], tl[2]);
        gl.uniform3f(progs.final.u("uTintDeep"), td[0], td[1], td[2]);
      }
      gl.uniform1f(progs.final.u("uFs"), fieldScale);
      gl.uniform1f(progs.final.u("uShScale"), Math.min(2, Math.max(0.6, (meanW * 0.5) / 7)));
      gl.uniform2f(progs.final.u("uOriginCss"), x0, y0);
      gl.uniform2f(progs.final.u("uRectCss"), rectW, rectH);

      if (material === "silver") {
        // contact with the glass layer (if any): textures + wrap tunables
        const fp = progs.final;
        glassU(fp);
        gl.uniform1i(fp.u("uGC"), 3);
        gl.uniform1f(fp.u("uTint"), knob("tintBleed", 0.2));
        gl.uniform1f(fp.u("uSeam"), knob("seam", 0.6));
        gl.uniform1f(fp.u("uBevel"), knob("bevel", 0.8));
        gl.uniform1f(fp.u("uBevW"), Math.min(3, Math.max(1.2, 0.12 * meanW)));
        gl.uniform1f(fp.u("uFlatG"), knob("flattenGlass", 0.9));
        gl.uniform1f(fp.u("uFlatW"), knob("flattenWidth", 10));
        // Metal tint (defaults match sterling silver)
        const ml = opts.tintLight || [0.957, 0.965, 0.973];
        const md = opts.tintDeep || [0.478, 0.529, 0.58];
        gl.uniform3f(fp.u("uMetalLight"), ml[0], ml[1], ml[2]);
        gl.uniform3f(fp.u("uMetalDeep"), md[0], md[1], md[2]);
      }
      fullscreen();

      const rect = {
        x: x0,
        y: y0,
        w: rectW,
        h: rectH,
        sx: 0,
        sy: canvas.height - vh,
        sw: vw,
        sh: vh,
      };
      lastPass = { vw, vh, gw, gh, thr, fieldScale, rect, seeds };
      return rect;
    }

    /**
     * Glass only. Re-runs just the last pass of the previous render() to write the signed
     * distance to the glass edge (R fine, G coarse, 0.5 = on the edge) into the canvas, same rect as
     * the colour render. Call right after copying render()'s colour out of the canvas.
     */
    function renderDist() {
      if (lost || !tex || !lastPass || !progs.dist) return null;
      const p = lastPass;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, p.vw, p.vh);
      gl.useProgram(progs.dist.p);
      bindTex(0, tex.comb);
      bindTex(1, p.seeds);
      gl.uniform1i(progs.dist.u("uComb"), 0);
      gl.uniform1i(progs.dist.u("uSeed"), 1);
      gl.uniform2f(progs.dist.u("uVp"), p.vw, p.vh);
      gl.uniform2f(progs.dist.u("uField"), p.gw, p.gh);
      gl.uniform1f(progs.dist.u("uThr"), p.thr);
      gl.uniform1f(progs.dist.u("uFs"), p.fieldScale);
      fullscreen();
      return p.rect;
    }

    return { canvas, resize, render, renderDist, isLost: () => lost };
  }

  window.SilverGL = { create };
})();
