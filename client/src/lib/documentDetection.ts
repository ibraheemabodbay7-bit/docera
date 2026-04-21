/**
 * documentDetection.ts
 *
 * Automatic document corner detection using a dual-path strategy:
 *
 * Path A — Multi-scale Canny edge detection
 *   1. Downscale to ≤800px
 *   2. Grayscale → contrast stretch
 *   3. Canny at 3×3 blur + Canny at 5×5 blur → OR the edge maps
 *   4. Connected contours → convex hull → minAreaRect → 4 tight corners
 *
 * Path B — Paper-score segmentation (white/grey paper detection)
 *   1. Per-pixel "paper score" = luminance × (1 − saturation)
 *      White/grey paper scores very high; colored surfaces score much lower.
 *   2. Morphological close (dilate→erode) fills small holes in paper region
 *   3. Largest paper-like blob → convex hull → minAreaRect → 4 tight corners
 *
 * Both paths produce a candidate quad; the one with the higher quality score
 * (large area, close to rectangular, closer to a standard document ratio) wins.
 *
 * Why minAreaRect instead of Douglas-Peucker simplification?
 *   D-P on a convex hull gives an N-vertex polygon.  Picking 4 "corners" from
 *   that polygon by the x+y-sum heuristic often lands INSIDE the true corners
 *   when the document is tilted.  minAreaRect (rotating calipers) always
 *   returns the tightest possible enclosing rectangle regardless of tilt,
 *   giving correct aspect-ratio output even for documents tilted 10-30°.
 */

import type { QuadPoints } from "./imageProcessing";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_DIM              = 1200;   // higher res → sharper edges, better accuracy
const MIN_AREA_RATIO       = 0.04;   // quad must cover ≥4% of the frame (detect farther docs)
const MAX_BLOB_RATIO       = 0.92;   // reject blobs that fill ≥92% (background)
const MAX_COMPONENT_PX     = 200_000; // larger budget for higher-res images
const DP_EPSILON_FACTOR    = 0.012;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pt { x: number; y: number }

export type DocType = "id_card" | "full_page" | "unknown";

export interface DetectionResult {
  quad: QuadPoints;
  docType: DocType;
}

// ─── Grayscale ────────────────────────────────────────────────────────────────

function toGray(px: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  return g;
}

// ─── CLAHE (Contrast-Limited Adaptive Histogram Equalization) ─────────────────
//
// Essential for detecting white paper on similarly-bright surfaces (light desk,
// white tablecloth).  Global contrast stretch gives only a 10-15 grey-level
// difference at the paper edge; CLAHE amplifies LOCAL contrast per tile,
// making subtle paper boundaries clearly visible to Canny.
//
// Algorithm:
//   1. Divide image into tiles×tiles grid.
//   2. Per tile: build histogram, clip at limit×mean, redistribute excess, build CDF.
//   3. Map each pixel via bilinear interpolation between its 4 surrounding tile CDFs.
//
// clip=3.0 prevents noise explosion in very flat (uniform) regions.

function applyClahe(
  g: Float32Array, w: number, h: number, tiles = 8, clip = 3.0
): Float32Array {
  const cellW = Math.ceil(w / tiles);
  const cellH = Math.ceil(h / tiles);

  // Step 1: per-tile equalization lookup tables
  const luts: Uint8Array[] = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Float32Array(256);
      const sx = tx * cellW, sy = ty * cellH;
      const ex = Math.min(sx + cellW, w), ey = Math.min(sy + cellH, h);
      let n = 0;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          hist[Math.min(255, Math.max(0, Math.round(g[y * w + x])))]++;
          n++;
        }
      }
      // Clip bins and redistribute excess uniformly
      const limit = clip * n / 256;
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
      }
      const add = excess / 256;
      for (let i = 0; i < 256; i++) hist[i] += add;
      // Build normalised CDF → LUT [0..255]
      const lut = new Uint8Array(256);
      let sum = 0, cdfMin = 0, first = true;
      for (let i = 0; i < 256; i++) {
        sum += hist[i];
        if (first && hist[i] > 0) { cdfMin = sum - hist[i]; first = false; }
        const denom = Math.max(1, n - cdfMin);
        lut[i] = Math.min(255, Math.round(((sum - cdfMin) / denom) * 255));
      }
      luts.push(lut);
    }
  }

  // Step 2: bilinear interpolation between tile LUTs
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Fractional tile coordinates (0.5 offset → pixel centres align to tile centres)
      const gxf = (x + 0.5) / cellW - 0.5;
      const gyf = (y + 0.5) / cellH - 0.5;
      const tx0 = Math.max(0, Math.floor(gxf));
      const ty0 = Math.max(0, Math.floor(gyf));
      const tx1 = Math.min(tiles - 1, tx0 + 1);
      const ty1 = Math.min(tiles - 1, ty0 + 1);
      const fx = Math.max(0, Math.min(1, gxf - tx0));
      const fy = Math.max(0, Math.min(1, gyf - ty0));
      const v = Math.min(255, Math.max(0, Math.round(g[y * w + x])));
      out[y * w + x] =
        luts[ty0 * tiles + tx0][v] * (1 - fx) * (1 - fy) +
        luts[ty0 * tiles + tx1][v] * fx        * (1 - fy) +
        luts[ty1 * tiles + tx0][v] * (1 - fx)  * fy       +
        luts[ty1 * tiles + tx1][v] * fx         * fy;
    }
  }
  return out;
}

// ─── Paper score (luminance × desaturation) ───────────────────────────────────
//
// White / grey paper → high luminance, low chroma → high paper score.
// Colored desk, skin, fabric → medium luminance but notable chroma → lower score.
// This discriminates paper from similarly bright but colored surfaces much better
// than raw luminance alone.

function toPaperScore(px: Uint8ClampedArray, n: number): Float32Array {
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const L    = 0.299 * r + 0.587 * g + 0.114 * b;
    const cMax = Math.max(r, g, b);
    const cMin = Math.min(r, g, b);
    // normalised saturation (0–1); adding 1 avoids div-by-zero when cMax = 0
    const sat  = (cMax - cMin) / (cMax + 1);
    score[i]   = L * (1 - sat * 1.6);   // penalise coloured pixels
  }
  return score;
}

// ─── Contrast stretch (1%–99% percentile clamp) ───────────────────────────────
// Uses histogram-based percentile (O(n)) — much faster than sorting for large images.

function stretchContrast(g: Float32Array): Float32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.min(255, Math.max(0, Math.round(g[i])))]++;
  const n = g.length;
  let lo = 0, hi = 255, cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= n * 0.01) { lo = i; break; }
  }
  cum = 0;
  for (let i = 255; i >= 0; i--) {
    cum += hist[i];
    if (cum >= n * 0.01) { hi = i; break; }
  }
  if (hi - lo < 8) return g;
  const range = hi - lo;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    out[i] = Math.max(0, Math.min(255, (g[i] - lo) * 255 / range));
  }
  return out;
}

// ─── Gaussian blur 3×3 ────────────────────────────────────────────────────────

function blur3(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      out[y * w + x] = (
        g[(y-1)*w+x-1] + 2*g[(y-1)*w+x] + g[(y-1)*w+x+1] +
        2*g[y*w+x-1]   + 4*g[y*w+x]     + 2*g[y*w+x+1]   +
        g[(y+1)*w+x-1] + 2*g[(y+1)*w+x] + g[(y+1)*w+x+1]
      ) / 16;
    }
  }
  for (let x = 0; x < w; x++) { out[x] = g[x]; out[(h-1)*w+x] = g[(h-1)*w+x]; }
  for (let y = 0; y < h; y++) { out[y*w] = g[y*w]; out[y*w+w-1] = g[y*w+w-1]; }
  return out;
}

// ─── Gaussian blur 5×5 ────────────────────────────────────────────────────────

function blur5(g: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 2; x < w - 2; x++) {
      tmp[y*w+x] = (
        g[y*w+x-2] + 4*g[y*w+x-1] + 6*g[y*w+x] + 4*g[y*w+x+1] + g[y*w+x+2]
      ) / 16;
    }
    tmp[y*w] = g[y*w]; tmp[y*w+1] = g[y*w+1];
    tmp[y*w+w-1] = g[y*w+w-1]; tmp[y*w+w-2] = g[y*w+w-2];
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 2; y < h - 2; y++) {
      out[y*w+x] = (
        tmp[(y-2)*w+x] + 4*tmp[(y-1)*w+x] + 6*tmp[y*w+x] + 4*tmp[(y+1)*w+x] + tmp[(y+2)*w+x]
      ) / 16;
    }
    out[x] = tmp[x]; out[w+x] = tmp[w+x];
    out[(h-1)*w+x] = tmp[(h-1)*w+x]; out[(h-2)*w+x] = tmp[(h-2)*w+x];
  }
  return out;
}

// ─── Sobel + NMS ──────────────────────────────────────────────────────────────

const NMS_OFFSETS: [number, number][] = [[0, 1], [1, 1], [1, 0], [1, -1]];

function sobel(g: Float32Array, w: number, h: number): { mag: Float32Array; dir: Uint8Array } {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = g[(y-1)*w+x-1], tc = g[(y-1)*w+x], tr = g[(y-1)*w+x+1];
      const ml = g[y*w+x-1],                         mr = g[y*w+x+1];
      const bl = g[(y+1)*w+x-1], bc = g[(y+1)*w+x], br = g[(y+1)*w+x+1];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      mag[y*w+x] = Math.sqrt(gx*gx + gy*gy);
      dir[y*w+x] = Math.round(((Math.atan2(gy, gx) * 4 / Math.PI) + 8) % 4) % 4;
    }
  }
  return { mag, dir };
}

function nonMaxSuppression(mag: Float32Array, dir: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y*w+x;
      const m = mag[i];
      if (m === 0) continue;
      const [dy, dx] = NMS_OFFSETS[dir[i]];
      if (m >= mag[(y+dy)*w+(x+dx)] && m >= mag[(y-dy)*w+(x-dx)]) out[i] = m;
    }
  }
  return out;
}

// ─── Adaptive Canny thresholds ────────────────────────────────────────────────
// Uses histogram-based percentile (O(n)) — no sort needed.

function adaptiveThresholds(nmsMap: Float32Array, sensitive = false): [number, number] {
  let maxVal = 0;
  for (let i = 0; i < nmsMap.length; i++) if (nmsMap[i] > maxVal) maxVal = nmsMap[i];
  if (maxVal < 1) return [15, 50];
  const BINS = 512;
  const scale = (BINS - 1) / maxVal;
  const hist = new Uint32Array(BINS);
  let total = 0;
  for (let i = 0; i < nmsMap.length; i++) {
    if (nmsMap[i] > 0) { hist[Math.min(BINS-1, Math.round(nmsMap[i] * scale))]++; total++; }
  }
  if (total < 100) return [15, 50];
  const hiPct = sensitive ? 0.55 : 0.70;
  let cum = 0;
  let hiBin = BINS - 1;
  for (let i = BINS - 1; i >= 0; i--) {
    cum += hist[i];
    if (cum >= total * (1 - hiPct)) { hiBin = i; break; }
  }
  const hi = hiBin / scale;
  const lo = hi * 0.35;
  return [Math.max(5, lo), Math.max(20, hi)];
}

function hysteresis(nmsMap: Float32Array, w: number, h: number, lo: number, hi: number): Uint8Array {
  const n = w * h;
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (nmsMap[i] >= hi) edge[i] = 2;
    else if (nmsMap[i] >= lo) edge[i] = 1;
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (edge[i] === 2) queue.push(i);
  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const y = Math.floor(idx / w), x = idx % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dy && !dx) continue;
        const ny = y+dy, nx = x+dx;
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        const ni = ny*w+nx;
        if (edge[ni] === 1) { edge[ni] = 2; queue.push(ni); }
      }
    }
  }
  for (let i = 0; i < n; i++) if (edge[i] !== 2) edge[i] = 0;
  return edge;
}

function dilate3(edge: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (
        edge[y*w+x] || edge[(y-1)*w+x] || edge[(y+1)*w+x] ||
        edge[y*w+x-1] || edge[y*w+x+1]
      ) out[y*w+x] = 1;
    }
  }
  return out;
}

function orEdges(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

function runCanny(
  normalized: Float32Array, w: number, h: number,
  blurFn: (g: Float32Array, w: number, h: number) => Float32Array,
  sensitive = false,
): Uint8Array {
  const blurred = blurFn(normalized, w, h);
  const { mag, dir } = sobel(blurred, w, h);
  const nmsMap = nonMaxSuppression(mag, dir, w, h);
  const [lo, hi] = adaptiveThresholds(nmsMap, sensitive);
  const raw = hysteresis(nmsMap, w, h, lo, hi);
  return dilate3(raw, w, h);
}

// ─── Hough Transform — dominant line detection ────────────────────────────────
//
// This is the primary detection path for challenging cases (white paper on
// light desk, faint edges, partial shadows).  Unlike contour-based methods that
// require a fully-connected edge chain, Hough works by letting each edge pixel
// vote independently for every line it could lie on.  A long straight paper edge
// — even with gaps — accumulates hundreds of votes in the same (r,θ) bin and
// produces a sharp peak, while random background edges are spread over many bins.
//
// Steps:
//   1. Each edge pixel (x,y) votes: r = x·cos(θ) + y·sin(θ) for θ ∈ [0°,179°]
//   2. Greedy peak extraction with (suppRadius) suppression radius
//   3. Try all C(N,4) combinations of the top-N lines; each ordering of 4 lines
//      gives a candidate quad from pairwise intersections
//   4. Keep the quad with the highest quadQualityScore

const HOUGH_THETA  = 180;   // 1° resolution
const HOUGH_R_STEP = 2;     // r-bucket size in pixels

// Precomputed at module level (cheap, avoids per-call allocation)
const _hCos = new Float32Array(HOUGH_THETA);
const _hSin = new Float32Array(HOUGH_THETA);
for (let t = 0; t < HOUGH_THETA; t++) {
  const a = (t * Math.PI) / HOUGH_THETA;
  _hCos[t] = Math.cos(a); _hSin[t] = Math.sin(a);
}

interface HoughLine { r: number; theta: number; votes: number }

// Gradient-weighted Hough: accepts raw Sobel magnitude map (optional).
// When provided, each pixel's vote = magnitude >> 3 (min 1).
// Strong paper boundaries accumulate far more than scattered noise/texture.
// When mag is omitted, falls back to binary 1-vote-per-edge-pixel.
function detectHoughLines(
  edges: Uint8Array, w: number, h: number,
  mag?: Float32Array,
): HoughLine[] {
  const diag   = Math.ceil(Math.sqrt(w * w + h * h));
  const rOffset = diag;
  const rBins   = Math.ceil(2 * diag / HOUGH_R_STEP) + 2;
  const acc     = new Int32Array(HOUGH_THETA * rBins);

  // Vote — magnitude-weighted if mag provided, binary otherwise.
  // Weight: clamp mag/8 to [1, 20] to avoid accumulator overflow.
  if (mag) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = mag[y * w + x];
        if (m < 4) continue;   // ignore sub-noise gradients
        const weight = Math.min(20, Math.max(1, Math.round(m / 8)));
        for (let t = 0; t < HOUGH_THETA; t++) {
          const rBin = Math.round((x * _hCos[t] + y * _hSin[t] + rOffset) / HOUGH_R_STEP);
          if (rBin >= 0 && rBin < rBins) acc[t * rBins + rBin] += weight;
        }
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!edges[y * w + x]) continue;
        for (let t = 0; t < HOUGH_THETA; t++) {
          const rBin = Math.round((x * _hCos[t] + y * _hSin[t] + rOffset) / HOUGH_R_STEP);
          if (rBin >= 0 && rBin < rBins) acc[t * rBins + rBin]++;
        }
      }
    }
  }

  // Collect candidates above threshold.
  // 8% of max: keeps faint paper-boundary peaks that would be lost at 15%.
  // The quad quality score filters out bad line combinations.
  let maxVotes = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxVotes) maxVotes = acc[i];
  const minV = Math.max(15, maxVotes * 0.08);

  const cands: { t: number; rb: number; v: number }[] = [];
  for (let t = 0; t < HOUGH_THETA; t++) {
    for (let rb = 0; rb < rBins; rb++) {
      const v = acc[t * rBins + rb];
      if (v >= minV) cands.push({ t, rb, v });
    }
  }
  cands.sort((a, b) => b.v - a.v);

  // Greedy non-maximum suppression in (θ, r) space.
  // Work entirely in bin-index space — no floating point needed here.
  const suppT = 10, suppR = 12;
  // Store selected peaks as {tBin, rBin} for cheap distance checks
  const selBins: { tBin: number; rBin: number }[] = [];
  const peaks: HoughLine[] = [];

  for (const c of cands) {
    if (peaks.length >= 40) break;
    let tooClose = false;
    for (const s of selBins) {
      const dTheta = Math.min(Math.abs(c.t - s.tBin), HOUGH_THETA - Math.abs(c.t - s.tBin));
      if (dTheta > suppT) continue;
      if (Math.abs(c.rb - s.rBin) <= suppR) { tooClose = true; break; }
    }
    if (!tooClose) {
      selBins.push({ tBin: c.t, rBin: c.rb });
      peaks.push({
        r:     c.rb * HOUGH_R_STEP - rOffset,
        theta: (c.t * Math.PI) / HOUGH_THETA,
        votes: c.v,
      });
    }
  }
  return peaks;
}

function houghIntersect(
  r1: number, t1: number, r2: number, t2: number
): Pt | null {
  const c1 = Math.cos(t1), s1 = Math.sin(t1);
  const c2 = Math.cos(t2), s2 = Math.sin(t2);
  const det = c1 * s2 - c2 * s1;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (r1 * s2 - r2 * s1) / det,
    y: (r2 * c1 - r1 * c2) / det,
  };
}

// Try all combinations of 4 Hough lines to find the best document quad.
function findBestQuadFromHoughLines(
  lines: HoughLine[], w: number, h: number
): { tl: Pt; tr: Pt; bl: Pt; br: Pt } | null {
  const top = lines.slice(0, 40);
  const n   = top.length;
  if (n < 4) return null;

  const margin = Math.max(w, h) * 0.12;   // allow corners slightly outside frame

  let bestQuad: { tl: Pt; tr: Pt; bl: Pt; br: Pt } | null = null;
  let bestScore = 0;

  // 3 cyclic orderings of 4 lines that produce distinct quadrilaterals
  const orderings: [number, number, number, number][] = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3],
  ];

  for (let a = 0; a < n - 3; a++) {
    for (let b = a + 1; b < n - 2; b++) {
      for (let c = b + 1; c < n - 1; c++) {
        for (let d = c + 1; d < n; d++) {
          const combo = [top[a], top[b], top[c], top[d]];

          for (const [i0, i1, i2, i3] of orderings) {
            const ls = [combo[i0], combo[i1], combo[i2], combo[i3]];
            const corners: Pt[] = [];
            let valid = true;

            for (let k = 0; k < 4 && valid; k++) {
              const l1 = ls[k], l2 = ls[(k + 1) % 4];
              const pt = houghIntersect(l1.r, l1.theta, l2.r, l2.theta);
              if (!pt) { valid = false; break; }
              if (
                pt.x < -margin || pt.x > w + margin ||
                pt.y < -margin || pt.y > h + margin
              ) { valid = false; break; }
              corners.push(pt);
            }
            if (!valid || corners.length !== 4) continue;

            let tl = corners[0], tr = corners[0], bl = corners[0], br = corners[0];
            let tlS = Infinity, trS = Infinity, blS = Infinity, brS = Infinity;
            for (const p of corners) {
              if (p.x + p.y < tlS)               { tlS = p.x + p.y; tl = p; }
              if ((w - p.x) + p.y < trS)          { trS = (w - p.x) + p.y; tr = p; }
              if (p.x + (h - p.y) < blS)          { blS = p.x + (h - p.y); bl = p; }
              if ((w - p.x) + (h - p.y) < brS)    { brS = (w - p.x) + (h - p.y); br = p; }
            }

            const score = quadQualityScore(tl, tr, bl, br, w, h);
            if (score > bestScore) { bestScore = score; bestQuad = { tl, tr, bl, br }; }
          }
        }
      }
    }
  }

  return bestQuad;
}

// ─── Morphological close (dilate then erode) ──────────────────────────────────
//
// Fills small holes and thin gaps in a binary mask.
// This is critical for paper-region segmentation: shadows and texture cause
// small "holes" in the paper region that split it into multiple components.
//
// morphClose5 uses a 5×5 diamond kernel which fills larger gaps than 3×3,
// helping when the document has heavier shadow or rich printed texture.

function morphClose5(mask: Uint8Array, w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (
        mask[y*w+x] || mask[(y-1)*w+x] || mask[(y+1)*w+x] ||
        mask[y*w+x-1] || mask[y*w+x+1] ||
        mask[(y-2)*w+x] || mask[(y+2)*w+x] ||
        mask[y*w+x-2] || mask[y*w+x+2] ||
        mask[(y-1)*w+x-1] || mask[(y-1)*w+x+1] ||
        mask[(y+1)*w+x-1] || mask[(y+1)*w+x+1]
      ) d[y*w+x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (
        d[y*w+x] && d[(y-1)*w+x] && d[(y+1)*w+x] &&
        d[y*w+x-1] && d[y*w+x+1] &&
        d[(y-2)*w+x] && d[(y+2)*w+x] &&
        d[y*w+x-2] && d[y*w+x+2] &&
        d[(y-1)*w+x-1] && d[(y-1)*w+x+1] &&
        d[(y+1)*w+x-1] && d[(y+1)*w+x+1]
      ) out[y*w+x] = 1;
    }
  }
  return out;
}

function morphClose3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (
        mask[y*w+x]     || mask[(y-1)*w+x]   || mask[(y+1)*w+x]   ||
        mask[y*w+x-1]   || mask[y*w+x+1]     ||
        mask[(y-1)*w+x-1] || mask[(y-1)*w+x+1] ||
        mask[(y+1)*w+x-1] || mask[(y+1)*w+x+1]
      ) d[y*w+x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (
        d[y*w+x]     && d[(y-1)*w+x]   && d[(y+1)*w+x]   &&
        d[y*w+x-1]   && d[y*w+x+1]     &&
        d[(y-1)*w+x-1] && d[(y-1)*w+x+1] &&
        d[(y+1)*w+x-1] && d[(y+1)*w+x+1]
      ) out[y*w+x] = 1;
    }
  }
  return out;
}

// ─── Convex hull (Andrew's monotone chain) ────────────────────────────────────

function cross(O: Pt, A: Pt, B: Pt): number {
  return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  let sample = pts;
  if (pts.length > 5000) {
    const step = Math.ceil(pts.length / 5000);
    sample = pts.filter((_, i) => i % step === 0);
  }
  const sorted = sample.slice().sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ─── Minimum Area Rectangle (rotating calipers) ───────────────────────────────
//
// Returns exactly 4 corners of the tightest enclosing rectangle of the hull.
// This is the key fix for the "too wide" / "wrong aspect ratio" problem:
//   • A tilted document's axis-aligned bounding box is wider than the document.
//   • The minAreaRect finds the rectangle rotated to match the document, giving
//     the correct A4 / ID-card / Letter aspect ratio in the output.
//   • Unlike D-P simplification (which gives an arbitrary N-vertex polygon),
//     this always gives exactly 4 tight corners.

function minAreaRect(hull: Pt[]): [Pt, Pt, Pt, Pt] {
  const n = hull.length;
  if (n < 2) {
    const xs = hull.map(p => p.x), ys = hull.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  }

  let minArea = Infinity;
  let bestCorners: [Pt, Pt, Pt, Pt] = [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}];

  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;

    const ux = dx / len, uy = dy / len;  // unit vector along edge
    const vx = -uy,     vy = ux;         // perpendicular (rotated 90° CCW)

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;

    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const area = (maxU - minU) * (maxV - minV);
    if (area < minArea) {
      minArea = area;
      bestCorners = [
        { x: minU*ux + minV*vx, y: minU*uy + minV*vy },
        { x: maxU*ux + minV*vx, y: maxU*uy + minV*vy },
        { x: maxU*ux + maxV*vx, y: maxU*uy + maxV*vy },
        { x: minU*ux + maxV*vx, y: minU*uy + maxV*vy },
      ];
    }
  }

  return bestCorners;
}

// Assign TL/TR/BL/BR from 4 arbitrary corners (from minAreaRect output)
function assignMbrCorners(
  corners: [Pt, Pt, Pt, Pt], w: number, h: number
): { tl: Pt; tr: Pt; bl: Pt; br: Pt } {
  let tl = corners[0], tr = corners[0], bl = corners[0], br = corners[0];
  let tlS = Infinity, trS = Infinity, blS = Infinity, brS = Infinity;
  for (const p of corners) {
    const s1 = p.x + p.y;           if (s1 < tlS) { tlS = s1; tl = p; }
    const s2 = (w - p.x) + p.y;     if (s2 < trS) { trS = s2; tr = p; }
    const s3 = p.x + (h - p.y);     if (s3 < blS) { blS = s3; bl = p; }
    const s4 = (w - p.x) + (h - p.y); if (s4 < brS) { brS = s4; br = p; }
  }
  return { tl, tr, bl, br };
}

// ─── Polygon area ─────────────────────────────────────────────────────────────

function polyArea(pts: Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i+1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function polyPerimeter(pts: Pt[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i+1) % pts.length;
    p += Math.sqrt((pts[i].x-pts[j].x)**2 + (pts[i].y-pts[j].y)**2);
  }
  return p;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x-a.x, dy = b.y-a.y;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.sqrt((p.x-a.x)**2 + (p.y-a.y)**2);
  return Math.abs((p.x-a.x)*dy - (p.y-a.y)*dx) / Math.sqrt(lenSq);
}

function dpSimplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length-1]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= epsilon) return [pts[0], pts[pts.length-1]];
  return [
    ...dpSimplify(pts.slice(0, maxIdx+1), epsilon).slice(0, -1),
    ...dpSimplify(pts.slice(maxIdx), epsilon),
  ];
}

function simplifyClosedPoly(hull: Pt[], epsilon: number): Pt[] {
  if (hull.length <= 4) return hull.slice();
  const chain = [...hull, hull[0]];
  const simplified = dpSimplify(chain, epsilon);
  if (simplified.length && simplified[0] === simplified[simplified.length-1]) simplified.pop();
  return simplified;
}

// ─── Connected components via BFS ─────────────────────────────────────────────

function findContours(edge: Uint8Array, w: number, h: number): Pt[][] {
  const visited = new Uint8Array(w * h);
  const contours: Pt[][] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y*w+x;
      if (!edge[i] || visited[i]) continue;
      const pts: Pt[] = [];
      const queue = [i];
      visited[i] = 1;
      let qi = 0;
      while (qi < queue.length && pts.length < MAX_COMPONENT_PX) {
        const idx = queue[qi++];
        pts.push({ x: idx % w, y: Math.floor(idx / w) });
        const cy = Math.floor(idx / w), cx = idx % w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dy && !dx) continue;
            const ny = cy+dy, nx = cx+dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
            const ni = ny*w+nx;
            if (edge[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
          }
        }
      }
      if (pts.length > 30) contours.push(pts);
    }
  }
  return contours;
}

// ─── Quad quality scoring ─────────────────────────────────────────────────────
//
// Scores a candidate quad on:
//   1. Area ratio — how much of the frame it covers (prefers larger docs)
//   2. Rectangularity — how parallel and equal-length opposite sides are
//   3. Aspect ratio — penalises extreme ratios (>4:1 or <1:4) unlikely for docs
//
// Returns a value in [0, 1]. Higher = better.

function quadQualityScore(
  tl: Pt, tr: Pt, bl: Pt, br: Pt, w: number, h: number
): number {
  const area = polyArea([tl, tr, br, bl]);
  const areaRatio = area / (w * h);

  // Must cover 8%–92% of frame
  if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_BLOB_RATIO) return 0;

  const topW  = Math.sqrt((tr.x-tl.x)**2 + (tr.y-tl.y)**2);
  const botW  = Math.sqrt((br.x-bl.x)**2 + (br.y-bl.y)**2);
  const leftH = Math.sqrt((bl.x-tl.x)**2 + (bl.y-tl.y)**2);
  const rightH = Math.sqrt((br.x-tr.x)**2 + (br.y-tr.y)**2);

  const maxW = Math.max(topW, botW, 1);
  const maxH = Math.max(leftH, rightH, 1);

  // Rectangularity: 1 when opposite sides are equal length
  const rectW = Math.min(topW, botW) / maxW;
  const rectH = Math.min(leftH, rightH) / maxH;
  const rectangularity = rectW * rectH;

  // Aspect ratio sanity check
  const ratio = maxW / maxH;
  if (ratio < 0.20 || ratio > 5.0) return 0;

  return areaRatio * rectangularity;
}

// ─── Find best quad from Canny edge map ───────────────────────────────────────
//
// Scores all candidate contours (not just the largest) so that a large
// background contour never beats the actual document boundary.
// For each candidate, tries both minAreaRect and D-P simplification and
// keeps whichever produces the higher quality score.

function findBestQuadFromEdges(
  edge: Uint8Array, w: number, h: number, minArea: number
): { tl: Pt; tr: Pt; bl: Pt; br: Pt } | null {
  const contours = findContours(edge, w, h);

  // Collect and sort by hull area (largest first), but score ALL of them
  const hulls: Pt[][] = [];
  for (const pts of contours) {
    const hull = convexHull(pts);
    if (polyArea(hull) >= minArea) hulls.push(hull);
  }

  // Fallback: merge all edge pixels into one hull
  if (hulls.length === 0) {
    const allPts: Pt[] = [];
    for (let i = 0; i < edge.length; i++) {
      if (edge[i]) allPts.push({ x: i % w, y: Math.floor(i / w) });
    }
    if (allPts.length < 20) return null;
    const hull = convexHull(allPts);
    if (polyArea(hull) >= minArea) hulls.push(hull);
    if (hulls.length === 0) return null;
  }

  // Sort by hull area descending, limit to top 8 to keep it fast
  hulls.sort((a, b) => polyArea(b) - polyArea(a));
  const candidates = hulls.slice(0, 8);

  let bestQuad: { tl: Pt; tr: Pt; bl: Pt; br: Pt } | null = null;
  let bestScore = 0;

  for (const hull of candidates) {
    if (hull.length < 3) continue;

    // minAreaRect candidate
    const mbrCorners = minAreaRect(hull);
    const mbr = assignMbrCorners(mbrCorners, w, h);
    const mbrScore = quadQualityScore(mbr.tl, mbr.tr, mbr.bl, mbr.br, w, h);
    if (mbrScore > bestScore) { bestScore = mbrScore; bestQuad = mbr; }

    // D-P simplification candidate (better for axis-aligned docs)
    const perim = polyPerimeter(hull);
    const dpPoly = simplifyClosedPoly(hull, perim * DP_EPSILON_FACTOR);
    if (dpPoly.length >= 4) {
      let tl = dpPoly[0], tr = dpPoly[0], bl = dpPoly[0], br = dpPoly[0];
      let tlS = Infinity, trS = Infinity, blS = Infinity, brS = Infinity;
      for (const p of dpPoly) {
        if (p.x+p.y < tlS)               { tlS = p.x+p.y; tl = p; }
        if ((w-p.x)+p.y < trS)           { trS = (w-p.x)+p.y; tr = p; }
        if (p.x+(h-p.y) < blS)           { blS = p.x+(h-p.y); bl = p; }
        if ((w-p.x)+(h-p.y) < brS)       { brS = (w-p.x)+(h-p.y); br = p; }
      }
      const dpScore = quadQualityScore(tl, tr, bl, br, w, h);
      if (dpScore > bestScore) { bestScore = dpScore; bestQuad = { tl, tr, bl, br }; }
    }
  }

  return bestQuad;
}

// ─── Paper-region segmentation ────────────────────────────────────────────────
//
// Uses per-pixel paper score (luminance × desaturation) to isolate white/grey
// paper from the background.  Morphological close fills shadow/texture holes.
// Returns 4 minAreaRect corners of the largest paper-like blob, or null.

function detectPaperDocument(
  px: Uint8ClampedArray, w: number, h: number, minArea: number
): { tl: Pt; tr: Pt; bl: Pt; br: Pt } | null {
  const score = toPaperScore(px, w * h);
  const sorted = score.slice().sort();

  // Try multiple thresholds: start at 68th percentile, then loosen/tighten.
  // Lower values (0.45, 0.50) specifically help with white paper on light desk.
  for (const pct of [0.68, 0.60, 0.75, 0.55, 0.82, 0.50, 0.45]) {
    const threshold = sorted[Math.floor(sorted.length * pct)];

    const mask = new Uint8Array(w * h);
    for (let i = 0; i < score.length; i++) {
      if (score[i] >= threshold) mask[i] = 1;
    }

    // Morphological close fills holes caused by text, shadows, logos.
    // Use 5×5 kernel for better gap-filling on heavily textured or shadowed docs.
    const closed = morphClose5(mask, w, h);

    // Find connected components in the paper mask
    const visited = new Uint8Array(w * h);
    let bestComponent: Pt[] | null = null;
    let bestSize = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!closed[i] || visited[i]) continue;
        const pts: Pt[] = [];
        const queue = [i];
        visited[i] = 1;
        let qi = 0;
        while (qi < queue.length && pts.length < MAX_COMPONENT_PX * 4) {
          const idx = queue[qi++];
          pts.push({ x: idx % w, y: Math.floor(idx / w) });
          const cy = Math.floor(idx / w), cx = idx % w;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dy && !dx) continue;
              const ny = cy + dy, nx = cx + dx;
              if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
              const ni = ny * w + nx;
              if (closed[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
            }
          }
        }
        if (pts.length > bestSize) { bestSize = pts.length; bestComponent = pts; }
      }
    }

    if (!bestComponent) continue;
    const frameArea = w * h;
    // Reject blob that fills too much of frame (≥92% → likely background)
    // or too little (< minArea → likely noise)
    if (bestSize > frameArea * MAX_BLOB_RATIO) continue;

    const hull = convexHull(bestComponent);
    if (polyArea(hull) < minArea) continue;

    // Use minAreaRect for a tight, rotation-aware bounding rectangle
    const corners = minAreaRect(hull);
    const assigned = assignMbrCorners(corners, w, h);

    // Validate: the quad must have a reasonable quality score
    if (quadQualityScore(assigned.tl, assigned.tr, assigned.bl, assigned.br, w, h) > 0) {
      return assigned;
    }
  }
  return null;
}

// ─── Document type classification ─────────────────────────────────────────────

const ID_CARD_RATIO  = 85.6 / 53.98;   // ISO/IEC 7810 ID-1 ≈ 1.586
const A4_RATIO       = 297 / 210;       // A4 ≈ 1.414
const PASSPORT_RATIO = 125 / 88;        // Passport ≈ 1.420
const LETTER_RATIO   = 11 / 8.5;        // US Letter ≈ 1.294
const RATIO_TOLERANCE = 0.14;

function classifyDocType(tl: Pt, tr: Pt, bl: Pt, br: Pt): DocType {
  const topW   = Math.sqrt((tr.x-tl.x)**2 + (tr.y-tl.y)**2);
  const botW   = Math.sqrt((br.x-bl.x)**2 + (br.y-bl.y)**2);
  const leftH  = Math.sqrt((bl.x-tl.x)**2 + (bl.y-tl.y)**2);
  const rightH = Math.sqrt((br.x-tr.x)**2 + (br.y-tr.y)**2);
  const avgW = (topW + botW) / 2;
  const avgH = (leftH + rightH) / 2;
  if (avgW < 1 || avgH < 1) return "unknown";
  const ratio = Math.max(avgW, avgH) / Math.min(avgW, avgH);
  const isClose = (t: number) => Math.abs(ratio - t) / t <= RATIO_TOLERANCE;
  if (isClose(ID_CARD_RATIO))  return "id_card";
  if (isClose(A4_RATIO) || isClose(PASSPORT_RATIO) || isClose(LETTER_RATIO)) return "full_page";
  return "unknown";
}

// ─── Quad validation ─────────────────────────────────────────────────────────

function isValidQuad(q: QuadPoints): boolean {
  const pts = [q.tl, q.tr, q.bl, q.br];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i+1; j < pts.length; j++) {
      if (Math.sqrt((pts[i].x-pts[j].x)**2 + (pts[i].y-pts[j].y)**2) < 0.04) return false;
    }
  }
  if (q.tl.x >= q.tr.x - 0.01) return false;
  if (q.bl.x >= q.br.x - 0.01) return false;
  if (q.tl.y >= q.bl.y - 0.01) return false;
  if (q.tr.y >= q.br.y - 0.01) return false;
  return true;
}

// ─── Corner refinement ────────────────────────────────────────────────────────
//
// From each candidate corner, walk outward along the centroid→corner direction
// and keep the furthest edge pixel found.  This "snaps" corners to the actual
// document boundary in the Canny edge map.

function refineCorner(
  corner: Pt, cx: number, cy: number,
  edges: Uint8Array, w: number, h: number
): Pt {
  const dx = corner.x - cx, dy = corner.y - cy;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len < 1e-6) return corner;
  const nx = dx/len, ny = dy/len;
  // Search up to 10% of the shortest frame dimension from the candidate corner
  const maxSearch = Math.round(Math.min(w, h) * 0.10);
  let bestX = corner.x, bestY = corner.y;
  for (let step = -4; step <= maxSearch; step++) {
    const px = Math.round(corner.x + nx*step), py = Math.round(corner.y + ny*step);
    if (px < 0 || px >= w || py < 0 || py >= h) break;
    if (edges[py*w+px]) { bestX = px; bestY = py; }
  }
  return { x: bestX, y: bestY };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function detectDocumentCorners(canvas: HTMLCanvasElement): DetectionResult | null {
  try {
    // 1. Downscale to MAX_DIM on the longest edge
    const scale = Math.min(1, MAX_DIM / Math.max(canvas.width, canvas.height));
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const small = document.createElement("canvas");
    small.width = w; small.height = h;
    small.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
    const px = small.getContext("2d")!.getImageData(0, 0, w, h).data;

    const gray       = toGray(px, w * h);
    const normalized = stretchContrast(gray);
    const minArea    = w * h * MIN_AREA_RATIO;

    // CLAHE-enhanced grayscale — dramatically improves white-on-white detection
    // by amplifying local contrast per 8×8 tile before edge detection.
    const clahed = applyClahe(normalized, w, h, 8, 3.0);

    // ── Path A: Multi-scale Canny on CLAHE-enhanced image ────────────────────
    const edges3 = runCanny(clahed, w, h, blur3, false);
    const edges5 = runCanny(clahed, w, h, blur5, false);
    const edgesCombined = orEdges(edges3, edges5);

    let cannyQuad = findBestQuadFromEdges(edgesCombined, w, h, minArea);
    if (!cannyQuad) {
      const edges3s = runCanny(clahed, w, h, blur3, true);
      const edges5s = runCanny(clahed, w, h, blur5, true);
      cannyQuad = findBestQuadFromEdges(orEdges(edges3s, edges5s), w, h, minArea);
    }

    // ── Path C: Gradient-weighted Hough-transform line detection ─────────────
    // Uses raw Sobel magnitude (not Canny-thresholded edges) as vote weights so
    // every pixel contributes proportionally to its gradient strength.  A long
    // paper boundary at mag=20 accumulates 20× more per-pixel than sub-noise
    // gradients at mag=1, making the boundary peak stand out even when text or
    // background creates many secondary peaks.
    //
    // Two sub-passes:
    //   H1 — magnitude map from blur3(clahed)  → catches most documents
    //   H2 — magnitude map from blur5(clahed)  → better for blurry/low-res
    // The fallback binary-edge pass runs only if both H1 and H2 produce low-
    // quality quads (< 0.15 quality score).
    const { mag: gradMag3 } = sobel(blur3(clahed, w, h), w, h);
    const { mag: gradMag5 } = sobel(blur5(clahed, w, h), w, h);

    const houghLines  = detectHoughLines(edgesCombined, w, h, gradMag3);
    const houghLines5 = detectHoughLines(edgesCombined, w, h, gradMag5);
    const houghQuad   = findBestQuadFromHoughLines(houghLines,  w, h);
    const houghQuadB  = findBestQuadFromHoughLines(houghLines5, w, h);

    // Pick the better of the two blur-scale results
    const hscore = (q: typeof houghQuad) =>
      q ? quadQualityScore(q.tl, q.tr, q.bl, q.br, w, h) : 0;
    const houghPrimary = (
      houghQuad && houghQuadB
        ? hscore(houghQuad) >= hscore(houghQuadB) ? houghQuad : houghQuadB
        : houghQuad ?? houghQuadB
    );

    // Fallback: binary edge pass for very faint boundaries missed by grad-map
    let houghQuad2: typeof houghPrimary = null;
    if (!houghPrimary || hscore(houghPrimary) < 0.15) {
      const edgesSens = orEdges(
        runCanny(clahed, w, h, blur3, true),
        runCanny(clahed, w, h, blur5, true),
      );
      houghQuad2 = findBestQuadFromHoughLines(
        detectHoughLines(edgesSens, w, h), w, h
      );
    }
    const houghBest = (
      houghPrimary && houghQuad2
        ? hscore(houghPrimary) >= hscore(houghQuad2) ? houghPrimary : houghQuad2
        : houghPrimary ?? houghQuad2
    );

    // ── Path B: Paper-score segmentation ─────────────────────────────────────
    // Luminance × desaturation isolates white/grey paper from coloured surfaces.
    const paperQuad = detectPaperDocument(px, w, h, minArea);

    // ── Choose best candidate from all three paths ────────────────────────────
    const score = (q: typeof cannyQuad) =>
      q ? quadQualityScore(q.tl, q.tr, q.bl, q.br, w, h) : 0;

    const cannyScore  = score(cannyQuad);
    const houghScore  = score(houghBest);
    const paperScore2 = score(paperQuad);

    // Pick the highest-scoring candidate.  Hough is given a small preference
    // (×1.1) because it is more likely to snap to the true paper boundary even
    // when paper and background colours are similar.
    let best = cannyQuad ?? houghBest ?? paperQuad;
    const scores: [typeof cannyQuad, number][] = [
      [cannyQuad,  cannyScore],
      [houghBest,  houghScore * 1.1],
      [paperQuad,  paperScore2],
    ];
    for (const [q, s] of scores) {
      if (q && s > score(best)) best = q;
    }
    if (!best) return null;

    let { tl, tr, bl, br } = best;

    // ── Corner refinement (Canny-based edge snap) ─────────────────────────────
    // Walk each corner along the centroid→corner ray to the furthest edge pixel.
    const cx = (tl.x + tr.x + bl.x + br.x) / 4;
    const cy = (tl.y + tr.y + bl.y + br.y) / 4;
    tl = refineCorner(tl, cx, cy, edgesCombined, w, h);
    tr = refineCorner(tr, cx, cy, edgesCombined, w, h);
    bl = refineCorner(bl, cx, cy, edgesCombined, w, h);
    br = refineCorner(br, cx, cy, edgesCombined, w, h);

    const docType = classifyDocType(tl, tr, bl, br);

    const clamp = (v: number) => Math.max(0.01, Math.min(0.99, v));
    const quad: QuadPoints = {
      tl: { x: clamp(tl.x / w), y: clamp(tl.y / h) },
      tr: { x: clamp(tr.x / w), y: clamp(tr.y / h) },
      bl: { x: clamp(bl.x / w), y: clamp(bl.y / h) },
      br: { x: clamp(br.x / w), y: clamp(br.y / h) },
    };

    if (!isValidQuad(quad)) return null;

    return { quad, docType };
  } catch {
    return null;
  }
}
