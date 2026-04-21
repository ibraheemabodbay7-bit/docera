export interface Point { x: number; y: number }
export interface QuadPoints { tl: Point; tr: Point; bl: Point; br: Point }

export const DEFAULT_QUAD: QuadPoints = {
  tl: { x: 0.1, y: 0.1 },
  tr: { x: 0.9, y: 0.1 },
  bl: { x: 0.1, y: 0.9 },
  br: { x: 0.9, y: 0.9 },
};

/**
 * Detect whether a canvas is likely a screenshot rather than a camera photo.
 * Screenshots have a very high proportion of near-white pixels (clean background)
 * and no photographic grain. Samples a coarse grid for speed.
 */
export function isScreenshotLike(canvas: HTMLCanvasElement): boolean {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  // Sample at most ~2 500 pixels spread across the image
  const stepX = Math.max(1, Math.floor(w / 50));
  const stepY = Math.max(1, Math.floor(h / 50));
  const data = ctx.getImageData(0, 0, w, h).data;
  let nearWhite = 0, total = 0;
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const i = (y * w + x) * 4;
      // Fast luma approximation
      const lum = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
      if (lum > 225) nearWhite++;
      total++;
    }
  }
  // ≥55 % bright pixels → very likely a screenshot with white/light background
  return total > 0 && nearWhite / total > 0.55;
}

/**
 * Apply an unsharp-mask sharpening pass.
 * @param canvas  Source canvas (not mutated).
 * @param amount  Sharpening strength — 0.55 is subtle, 0.9 is strong.
 */
export function sharpenCanvas(canvas: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  return _unsharpMask(canvas, amount);
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function solve8x8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = col; j <= n; j++) M[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function computeHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  return solve8x8(A, b);
}

// ─── WebGL singleton ───────────────────────────────────────────────────────────

type WarpGLCtx = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  posLoc: number;
  texLoc: WebGLUniformLocation;
  srcSizeLoc: WebGLUniformLocation;
  dstSizeLoc: WebGLUniformLocation;
  hLoc: WebGLUniformLocation;
  buf: WebGLBuffer;
};

let _warpGLCtx: WarpGLCtx | null | undefined;

const VERT_SRC = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG_SRC = `
  precision highp float;
  uniform sampler2D u_tex;
  uniform vec2 u_srcSize;
  uniform vec2 u_dstSize;
  uniform float u_h[8];
  void main() {
    float dx   = gl_FragCoord.x;
    float dy   = u_dstSize.y - gl_FragCoord.y;
    float denom = u_h[6]*dx + u_h[7]*dy + 1.0;
    float sx   = (u_h[0]*dx + u_h[1]*dy + u_h[2]) / denom;
    float sy   = (u_h[3]*dx + u_h[4]*dy + u_h[5]) / denom;
    if (sx < 0.0 || sy < 0.0 || sx >= u_srcSize.x || sy >= u_srcSize.y) {
      gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
      return;
    }
    vec2 uv = vec2(sx / u_srcSize.x, 1.0 - sy / u_srcSize.y);
    gl_FragColor = texture2D(u_tex, uv);
  }
`;

function initWarpGL(): WarpGLCtx | null {
  if (_warpGLCtx !== undefined) return _warpGLCtx;

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    antialias: false,
  }) as WebGLRenderingContext | null;
  if (!gl) { _warpGLCtx = null; return null; }

  function compileShader(type: number, src: string): WebGLShader | null {
    const s = gl!.createShader(type);
    if (!s) return null;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
      console.warn("[docera:warpGL] shader error:", gl!.getShaderInfoLog(s));
      gl!.deleteShader(s);
      return null;
    }
    return s;
  }

  const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) { _warpGLCtx = null; return null; }

  const prog = gl.createProgram();
  if (!prog) { _warpGLCtx = null; return null; }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[docera:warpGL] link error:", gl.getProgramInfoLog(prog));
    _warpGLCtx = null;
    return null;
  }

  const buf = gl.createBuffer();
  if (!buf) { _warpGLCtx = null; return null; }
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
    gl.STATIC_DRAW);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);

  _warpGLCtx = {
    gl, prog, buf,
    posLoc:    gl.getAttribLocation(prog, "a_pos"),
    texLoc:    gl.getUniformLocation(prog, "u_tex")!,
    srcSizeLoc: gl.getUniformLocation(prog, "u_srcSize")!,
    dstSizeLoc: gl.getUniformLocation(prog, "u_dstSize")!,
    hLoc:      gl.getUniformLocation(prog, "u_h")!,
  };
  return _warpGLCtx;
}

function perspectiveWarpGL(
  srcCanvas: HTMLCanvasElement,
  outW: number,
  outH: number,
  H: number[],
): HTMLCanvasElement | null {
  const ctx = initWarpGL();
  if (!ctx) return null;
  const { gl, prog, buf, posLoc, texLoc, srcSizeLoc, dstSizeLoc, hLoc } = ctx;

  (gl.canvas as HTMLCanvasElement).width  = outW;
  (gl.canvas as HTMLCanvasElement).height = outH;
  gl.viewport(0, 0, outW, outH);

  gl.useProgram(prog);

  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);

  gl.uniform1i(texLoc, 0);
  gl.uniform2f(srcSizeLoc, srcCanvas.width, srcCanvas.height);
  gl.uniform2f(dstSizeLoc, outW, outH);
  gl.uniform1fv(hLoc, H);

  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.deleteTexture(tex);

  const out = document.createElement("canvas");
  out.width  = outW;
  out.height = outH;
  out.getContext("2d")!.drawImage(gl.canvas as HTMLCanvasElement, 0, 0);
  return out;
}

function perspectiveWarpCPU(
  srcCanvas: HTMLCanvasElement,
  outW: number,
  outH: number,
  H: number[],
): HTMLCanvasElement {
  const [a, b, c, d, e, f, g, h] = H;
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const srcCtx = srcCanvas.getContext("2d")!;
  const srcData = srcCtx.getImageData(0, 0, sw, sh);
  const srcPx = srcData.data;

  const out = document.createElement("canvas");
  out.width  = outW;
  out.height = outH;
  const outCtx = out.getContext("2d")!;
  const outData = outCtx.createImageData(outW, outH);
  const outPx = outData.data;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const w2 = g * ox + h * oy + 1;
      const sx = (a * ox + b * oy + c) / w2;
      const sy = (d * ox + e * oy + f) / w2;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      const oi = (oy * outW + ox) * 4;

      if (x0 < 0 || y0 < 0 || x1 >= sw || y1 >= sh) {
        outPx[oi] = outPx[oi + 1] = outPx[oi + 2] = 255;
        outPx[oi + 3] = 255;
        continue;
      }

      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let ch = 0; ch < 4; ch++) {
        outPx[oi + ch] = Math.round(
          srcPx[i00 + ch] * (1 - fx) * (1 - fy) +
          srcPx[i10 + ch] * fx       * (1 - fy) +
          srcPx[i01 + ch] * (1 - fx) * fy       +
          srcPx[i11 + ch] * fx       * fy
        );
      }
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return out;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function perspectiveWarp(
  srcCanvas: HTMLCanvasElement,
  quad: QuadPoints,
  maxDim = 4000,
): HTMLCanvasElement {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const srcPts: [Point, Point, Point, Point] = [
    { x: quad.tl.x * sw, y: quad.tl.y * sh },
    { x: quad.tr.x * sw, y: quad.tr.y * sh },
    { x: quad.br.x * sw, y: quad.br.y * sh },
    { x: quad.bl.x * sw, y: quad.bl.y * sh },
  ];

  const topW  = dist(srcPts[0], srcPts[1]);
  const botW  = dist(srcPts[3], srcPts[2]);
  const leftH = dist(srcPts[0], srcPts[3]);
  const rightH = dist(srcPts[1], srcPts[2]);
  let outW = Math.round(Math.max(topW, botW));
  let outH = Math.round(Math.max(leftH, rightH));

  if (outW > maxDim || outH > maxDim) {
    const s = Math.min(maxDim / outW, maxDim / outH);
    outW = Math.round(outW * s);
    outH = Math.round(outH * s);
  }
  if (outW <= 0 || outH <= 0) return srcCanvas;

  const dstPts: [Point, Point, Point, Point] = [
    { x: 0,        y: 0        },
    { x: outW - 1, y: 0        },
    { x: outW - 1, y: outH - 1 },
    { x: 0,        y: outH - 1 },
  ];

  const H = computeHomography(dstPts, srcPts);

  const glResult = perspectiveWarpGL(srcCanvas, outW, outH, H);
  if (glResult) return glResult;

  return perspectiveWarpCPU(srcCanvas, outW, outH, H);
}

// ─── Flip ─────────────────────────────────────────────────────────────────────

/**
 * Mirror a canvas horizontally and/or vertically.
 * Returns the same canvas unchanged if both flags are false.
 */
export function flipCanvas(
  canvas: HTMLCanvasElement,
  flipH: boolean,
  flipV: boolean,
): HTMLCanvasElement {
  if (!flipH && !flipV) return canvas;
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.save();
  ctx.translate(flipH ? canvas.width : 0, flipV ? canvas.height : 0);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
  return out;
}

// ─── Watermark ────────────────────────────────────────────────────────────────
//
// Appends a thin white band BELOW the document content and places a faded
// "Docera" brand text in it.  The band keeps the watermark completely outside
// the document body so it never overlaps text or graphics.
//
// Design choices:
//   • Brand color #113e61 at 15% opacity → visible but non-distracting.
//   • Light (300) weight, medium-small font → professional, minimal.
//   • No shadow / halo — clean on white band background.
//   • Band height ≈ 2.8% of canvas height (min 36px) — just enough for the text.

export function applyWatermark(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;

  // Dedicated watermark band below the document content
  const bandH = Math.max(36, Math.round(h * 0.028));

  const out = document.createElement("canvas");
  out.width  = w;
  out.height = h + bandH;
  const ctx = out.getContext("2d")!;

  // Draw original document content
  ctx.drawImage(canvas, 0, 0);

  // White band background (matches typical scanned-paper colour)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, h, w, bandH);

  // Brand watermark: "Docera" — centered, light weight, brand color at 15% opacity
  const fontSize = Math.max(11, Math.round(w * 0.014));
  ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle    = "rgba(17, 62, 97, 0.15)";   // #113e61 @ 15%
  ctx.fillText("Docera", w / 2, h + bandH / 2);

  return out;
}

// ─── ID Card filter ───────────────────────────────────────────────────────────

export function idFilter(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const src = ctx.getImageData(0, 0, w, h).data;

  const blurred = new Float32Array(w * h * 3);
  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, wt = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sy = Math.max(0, Math.min(h - 1, y + ky));
          const sx = Math.max(0, Math.min(w - 1, x + kx));
          const k = K[(ky + 1) * 3 + (kx + 1)];
          const pi = (sy * w + sx) * 4;
          r += src[pi] * k; g += src[pi + 1] * k; b += src[pi + 2] * k;
          wt += k;
        }
      }
      const bi = (y * w + x) * 3;
      blurred[bi] = r / wt; blurred[bi + 1] = g / wt; blurred[bi + 2] = b / wt;
    }
  }

  const LUT = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    LUT[i] = Math.max(0, Math.min(255, Math.round((i * 1.04 - 128) * 1.2 + 128)));
  }

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const outCtx = out.getContext("2d")!;
  const outData = outCtx.createImageData(w, h);
  const dst = outData.data;

  const SHARPEN = 0.55;
  for (let i = 0; i < w * h; i++) {
    const pi = i * 4;
    const bi = i * 3;
    for (let c = 0; c < 3; c++) {
      const sharp = Math.max(0, Math.min(511, Math.round(src[pi + c] + SHARPEN * (src[pi + c] - blurred[bi + c]))));
      dst[pi + c] = LUT[sharp];
    }
    dst[pi + 3] = 255;
  }

  outCtx.putImageData(outData, 0, 0);
  return out;
}

// ─── No Shadow filter ─────────────────────────────────────────────────────────
//
// CamScanner-quality grayscale adaptive threshold filter.
//
// Algorithm:
//   1. Grayscale conversion (luminance weights).
//   2. 32×32 background grid — 95th-percentile per cell (sampled every 2px).
//      Captures localized shadows / lighting variation at fine granularity.
//      Cell floor = max(40, globalWhite×0.20) to prevent explosions in dark regions.
//   3. Per-pixel: divide by bilinear-interpolated background → normalize to [0,1].
//      Blend toward normalized output by strength slider (s=0 → original gray,
//      s=1 → fully normalized).
//   4. Adaptive threshold: pixels above adaptive_white × (0.82 - 0.12×s) → 255 (paper),
//      below → pushed dark. Creates pure white background + dark ink, strength-scaled.
//   5. Strong unsharp mask (amount 0.7) for CamScanner-level text sharpness.

export function noShadowFilter(canvas: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const src = ctx.getImageData(0, 0, w, h).data;

  const s = Math.max(0, Math.min(1, strength / 100));

  // ── Step 1: grayscale ─────────────────────────────────────────────────────
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (77 * src[i * 4] + 150 * src[i * 4 + 1] + 29 * src[i * 4 + 2]) >> 8;
  }

  // ── Step 2: global white reference (97th-percentile histogram) ───────────
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) hist[gray[i]]++;
  const target97 = Math.floor(w * h * 0.97);
  let cum = 0, globalWhite = 210;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= target97) { globalWhite = Math.max(170, i); break; }
  }

  // ── Step 3: 32×32 background grid, 95th-percentile per cell ─────────────
  const gridX = 32, gridY = 32;
  const cellW = Math.ceil(w / gridX);
  const cellH = Math.ceil(h / gridY);
  const bgGrid = new Float32Array(gridX * gridY);
  const minBg  = Math.max(40, globalWhite * 0.20);

  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      const vals: number[] = [];
      const sx = gx * cellW, sy = gy * cellH;
      const ex = Math.min(sx + cellW, w), ey = Math.min(sy + cellH, h);
      for (let y = sy; y < ey; y += 2) {
        for (let x = sx; x < ex; x += 2) vals.push(gray[y * w + x]);
      }
      vals.sort((a, b) => a - b);
      bgGrid[gy * gridX + gx] = Math.max(vals[Math.floor(vals.length * 0.95)] ?? globalWhite, minBg);
    }
  }

  // ── Step 4: per-pixel normalize + adaptive threshold + output ───────────
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const outCtx = out.getContext("2d")!;
  const outData = outCtx.createImageData(w, h);
  const dst = outData.data;

  // Threshold ratio: at s=1 aggressive (0.70), at s=0 lenient (0.82)
  // Pixels above (bg × thresh) → white; below → darkened toward black.
  const thresh = 0.82 - 0.12 * s;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gxf = (x + 0.5) / cellW - 0.5;
      const gyf = (y + 0.5) / cellH - 0.5;
      const gx0 = Math.max(0, Math.floor(gxf));
      const gy0 = Math.max(0, Math.floor(gyf));
      const gx1 = Math.min(gridX - 1, gx0 + 1);
      const gy1 = Math.min(gridY - 1, gy0 + 1);
      const fx = Math.max(0, Math.min(1, gxf - gx0));
      const fy = Math.max(0, Math.min(1, gyf - gy0));
      const bg =
        bgGrid[gy0 * gridX + gx0] * (1 - fx) * (1 - fy) +
        bgGrid[gy0 * gridX + gx1] * fx        * (1 - fy) +
        bgGrid[gy1 * gridX + gx0] * (1 - fx)  * fy +
        bgGrid[gy1 * gridX + gx1] * fx         * fy;

      const pi = (y * w + x) * 4;
      const g = gray[y * w + x];

      // Normalized grayscale: divide pixel by local background, scale to 255
      const norm = Math.min(255, Math.round((g / Math.max(bg, 1)) * 255));

      let out_v: number;
      if (s < 0.01) {
        // s≈0: pass through original grayscale
        out_v = g;
      } else {
        // Adaptive threshold: above thresh×255 → white; below → darken toward black
        const threshV = thresh * 255;
        if (norm >= threshV) {
          // Background → push toward white
          out_v = Math.round(255 - (255 - norm) * (1 - s) * 0.5);
        } else {
          // Foreground (ink) → push toward black
          const darkened = Math.round(norm * (1 - s * 0.6));
          out_v = Math.round(g * (1 - s) + darkened * s);
        }
      }

      dst[pi] = dst[pi + 1] = dst[pi + 2] = Math.max(0, Math.min(255, out_v));
      dst[pi + 3] = 255;
    }
  }

  outCtx.putImageData(outData, 0, 0);

  // ── Step 5: strong unsharp mask for CamScanner-level crispness ───────────
  return _unsharpMask(out, 0.70);
}

function _unsharpMask(canvas: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const src = ctx.getImageData(0, 0, w, h).data;
  const blur = new Uint8Array(w * h * 4);

  // 3×3 Gaussian kernel (sum=16)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const pi = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        blur[pi + c] = (
          src[((y-1)*w+x-1)*4+c]   + 2*src[((y-1)*w+x)*4+c]   + src[((y-1)*w+x+1)*4+c] +
          2*src[(y*w+x-1)*4+c]     + 4*src[(y*w+x)*4+c]       + 2*src[(y*w+x+1)*4+c] +
          src[((y+1)*w+x-1)*4+c]   + 2*src[((y+1)*w+x)*4+c]   + src[((y+1)*w+x+1)*4+c]
        ) >> 4;
      }
      blur[pi + 3] = 255;
    }
  }
  // Copy border rows/cols unchanged
  for (let x = 0; x < w; x++) {
    const p0 = x * 4, pL = ((h - 1) * w + x) * 4;
    for (let c = 0; c < 4; c++) { blur[p0 + c] = src[p0 + c]; blur[pL + c] = src[pL + c]; }
  }
  for (let y = 0; y < h; y++) {
    const p0 = y * w * 4, pR = (y * w + w - 1) * 4;
    for (let c = 0; c < 4; c++) { blur[p0 + c] = src[p0 + c]; blur[pR + c] = src[pR + c]; }
  }

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const outCtx = out.getContext("2d")!;
  const outData = outCtx.createImageData(w, h);
  const dst = outData.data;

  for (let i = 0; i < w * h; i++) {
    const pi = i * 4;
    for (let c = 0; c < 3; c++) {
      dst[pi + c] = Math.min(255, Math.max(0,
        Math.round(src[pi + c] + amount * (src[pi + c] - blur[pi + c]))
      ));
    }
    dst[pi + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

// ─── Document (B&W) filter ────────────────────────────────────────────────────

export function documentFilter(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;

  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (77 * px[i * 4] + 150 * px[i * 4 + 1] + 29 * px[i * 4 + 2]) >> 8;
  }

  const gridX = 8;
  const gridY = 8;
  const cellW = Math.ceil(w / gridX);
  const cellH = Math.ceil(h / gridY);
  const bgGrid = new Float32Array(gridX * gridY);

  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      const vals: number[] = [];
      const sx = gx * cellW;
      const sy = gy * cellH;
      const ex = Math.min(sx + cellW, w);
      const ey = Math.min(sy + cellH, h);
      for (let y = sy; y < ey; y += 4) {
        for (let x = sx; x < ex; x += 4) {
          vals.push(gray[y * w + x]);
        }
      }
      vals.sort((a, b) => a - b);
      bgGrid[gy * gridX + gx] = Math.max(vals[Math.floor(vals.length * 0.95)] || 255, 50);
    }
  }

  const LUT_SIZE = 512;
  const LUT = new Uint8Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const ratio = i / 255;
    const sigmoid = 1.0 / (1.0 + Math.exp(-12 * (ratio - 0.6)));
    LUT[i] = Math.round(Math.min(255, sigmoid * 255));
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d")!;
  const outData = outCtx.createImageData(w, h);
  const outPx = outData.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gxf = (x + 0.5) / cellW - 0.5;
      const gyf = (y + 0.5) / cellH - 0.5;
      const gx0 = Math.max(0, Math.floor(gxf));
      const gy0 = Math.max(0, Math.floor(gyf));
      const gx1 = Math.min(gridX - 1, gx0 + 1);
      const gy1 = Math.min(gridY - 1, gy0 + 1);
      const fx = Math.max(0, Math.min(1, gxf - gx0));
      const fy = Math.max(0, Math.min(1, gyf - gy0));

      const bg =
        bgGrid[gy0 * gridX + gx0] * (1 - fx) * (1 - fy) +
        bgGrid[gy0 * gridX + gx1] * fx       * (1 - fy) +
        bgGrid[gy1 * gridX + gx0] * (1 - fx) * fy       +
        bgGrid[gy1 * gridX + gx1] * fx       * fy;

      const i   = y * w + x;
      const pi  = i * 4;
      const lutIdx = Math.min(LUT_SIZE - 1, Math.max(0, Math.round((gray[i] / bg) * 255)));
      const val = LUT[lutIdx];
      outPx[pi] = val;
      outPx[pi + 1] = val;
      outPx[pi + 2] = val;
      outPx[pi + 3] = 255;
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return out;
}
