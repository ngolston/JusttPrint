'use strict';

/**
 * A model's geometry fingerprint, to find the same model saved as different files (an STL and
 * its 3MF, a re-export, a copy moved or turned on the plate): the duplicates that file hashes
 * cannot see.
 *
 * The fingerprint does not change when the model is moved or rotated: triangle count, surface
 * area, volume, the spread of the surface along its own three axes, and its handedness, so the
 * mirrored left and right parts of a kit are not taken for duplicates. Values are rounded to four
 * significant figures, so float noise between STL (32-bit) and 3MF (text) does not matter.
 *
 * The same design meshed at another resolution is a different fingerprint, but its measurements
 * stay close: volume and spreads within a few percent, and the shape (how the surface is spread
 * around its centre, a 16-bin histogram) nearly the same. `similarShape` compares those, for
 * "Same shape, any resolution" on the Duplicates page.
 */

const fflate = require('fflate');
const { classifyStlBuffer } = require('../shared/stl-sanity');
const { extractMeshFromXml } = require('../shared/threemf-mesh-extract');

/** Four significant figures, as text ("1.235e+3"), so near-equal values give the same key. */
const sig = (value) => (Number.isFinite(value) && value !== 0 ? Number(value).toPrecision(4) : '0');

/** Running sums over triangles: area, signed volume, and area-weighted moments of triangle centres. */
function accumulator() {
  return { tris: 0, area: 0, volume: 0, m: [0, 0, 0], mm: [0, 0, 0, 0, 0, 0] };
}

function addTriangle(acc, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  acc.tris++;
  acc.area += area;
  acc.volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  if (!area) return;
  const px = (ax + bx + cx) / 3;
  const py = (ay + by + cy) / 3;
  const pz = (az + bz + cz) / 3;
  acc.m[0] += area * px;
  acc.m[1] += area * py;
  acc.m[2] += area * pz;
  acc.mm[0] += area * px * px;
  acc.mm[1] += area * py * py;
  acc.mm[2] += area * pz * pz;
  acc.mm[3] += area * px * py;
  acc.mm[4] += area * px * pz;
  acc.mm[5] += area * py * pz;
}

/** Bins of the shape histogram: distance from the centre over the surface's RMS radius, 0 to 3. */
const SHAPE_BINS = 16;
const SHAPE_MAX_R = 3;
/** Where to sample each triangle for the histogram: its centre and the centres of its four parts' corners. */
const SAMPLES = [
  [1 / 3, 1 / 3, 1 / 3],
  [2 / 3, 1 / 6, 1 / 6],
  [1 / 6, 2 / 3, 1 / 6],
  [1 / 6, 1 / 6, 2 / 3]
];

/** Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi rotations). */
function eigenSymmetric(a) {
  const m = [
    [a[0][0], a[0][1], a[0][2]],
    [a[1][0], a[1][1], a[1][2]],
    [a[2][0], a[2][1], a[2][2]]
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(m[0][1]) + Math.abs(m[0][2]) + Math.abs(m[1][2]);
    if (off < 1e-14 * (Math.abs(m[0][0]) + Math.abs(m[1][1]) + Math.abs(m[2][2]) + 1e-300)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2]
    ]) {
      if (Math.abs(m[p][q]) < 1e-300) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const mkp = m[k][p];
        const mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq;
        m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p][k];
        const mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk;
        m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((i) => ({ value: m[i][i], vector: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.value - x.value);
}

/** The fingerprint from the running sums: { signature, triangles, area, volume }, or null for no surface. */
/**
 * The fingerprint and measurements from the sums of the first pass; `each` walks the triangles
 * again (each(fn) calls fn(ax, ay, az, bx, by, bz, cx, cy, cz)) for the handedness and the shape.
 */
function finish(acc, each) {
  if (!acc.tris || !acc.area) return null;
  const A = acc.area;
  const c = acc.m.map((x) => x / A);
  const cov = [
    [acc.mm[0] / A - c[0] * c[0], acc.mm[3] / A - c[0] * c[1], acc.mm[4] / A - c[0] * c[2]],
    [acc.mm[3] / A - c[0] * c[1], acc.mm[1] / A - c[1] * c[1], acc.mm[5] / A - c[1] * c[2]],
    [acc.mm[4] / A - c[0] * c[2], acc.mm[5] / A - c[1] * c[2], acc.mm[2] / A - c[2] * c[2]]
  ];
  const axes = eigenSymmetric(cov);
  const spreads = axes.map((axis) => Math.sqrt(Math.max(axis.value, 0)));
  // Handedness: point each axis where the surface leans (third moment); then the axes' orientation
  // tells a part from its mirror image. 0 when the shape is too symmetric to tell (then it is its own mirror).
  const scale = spreads[0] || 1;
  // Second pass: third moments along each axis (handedness), and the shape histogram.
  const thirds = [0, 0, 0];
  const shape = new Array(SHAPE_BINS).fill(0);
  const rms = Math.sqrt(spreads.reduce((sum, x) => sum + x * x, 0)) || 1;
  each((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const area = Math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2) / 2;
    if (!area) return;
    const px = (ax + bx + cx) / 3;
    const py = (ay + by + cy) / 3;
    const pz = (az + bz + cz) / 3;
    for (let k = 0; k < 3; k++) {
      const v = axes[k].vector;
      const d = (px - c[0]) * v[0] + (py - c[1]) * v[1] + (pz - c[2]) * v[2];
      thirds[k] += area * d * d * d;
    }
    for (const [wa, wb, wc] of SAMPLES) {
      const r = Math.hypot(wa * ax + wb * bx + wc * cx - c[0], wa * ay + wb * by + wc * cy - c[1], wa * az + wb * bz + wc * cz - c[2]) / rms;
      shape[Math.min(SHAPE_BINS - 1, Math.floor((r / SHAPE_MAX_R) * SHAPE_BINS))] += area / SAMPLES.length;
    }
  });
  const skews = thirds.map((s) => s / (A * scale * scale * scale));
  const SKEW_MIN = 1e-4;
  // Two leaning axes are enough: the third follows from them.
  const leaning = skews.filter((s) => Math.abs(s) > SKEW_MIN).length;
  let hand = 0;
  if (leaning >= 2) {
    const e = axes.map((axis, i) => (skews[i] < 0 ? axis.vector.map((x) => -x) : axis.vector));
    if (Math.abs(skews[2]) <= SKEW_MIN)
      e[2] = [e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2], e[0][0] * e[1][1] - e[0][1] * e[1][0]];
    else if (Math.abs(skews[1]) <= SKEW_MIN)
      e[1] = [e[2][1] * e[0][2] - e[2][2] * e[0][1], e[2][2] * e[0][0] - e[2][0] * e[0][2], e[2][0] * e[0][1] - e[2][1] * e[0][0]];
    else if (Math.abs(skews[0]) <= SKEW_MIN)
      e[0] = [e[1][1] * e[2][2] - e[1][2] * e[2][1], e[1][2] * e[2][0] - e[1][0] * e[2][2], e[1][0] * e[2][1] - e[1][1] * e[2][0]];
    const det =
      e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) - e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0]) + e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]);
    hand = det > 0 ? 1 : -1;
  }
  const volume = Math.abs(acc.volume);
  return {
    signature: [acc.tris, sig(A), sig(volume), ...spreads.map(sig), hand].join(':'),
    triangles: acc.tris,
    area: A,
    volume,
    spreads,
    hand,
    /** The share of the surface at each distance from the centre (16 bins, sums to 1). */
    shape: shape.map((x) => Math.round((x / A) * 10000) / 10000)
  };
}

/** An STL file's fingerprint (binary or ASCII), or null for one with no surface. */
function stlSignature(buffer) {
  const kind = classifyStlBuffer(buffer);
  /** @param {(...v: number[]) => void} fn */
  let each;
  if (kind === 'binary') {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const count = view.getUint32(80, true);
    each = (fn) => {
      for (let i = 0, offset = 84; i < count && offset + 50 <= buffer.byteLength; i++, offset += 50) {
        const f = (k) => view.getFloat32(offset + 12 + k * 4, true);
        fn(f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8));
      }
    };
  } else {
    // ASCII: parsed once (text is slow to read twice).
    const text = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('latin1');
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const all = [];
    let match;
    while ((match = re.exec(text)) !== null) all.push(Number(match[1]), Number(match[2]), Number(match[3]));
    const whole = all.length - (all.length % 9);
    each = (fn) => {
      for (let i = 0; i < whole; i += 9) fn(all[i], all[i + 1], all[i + 2], all[i + 3], all[i + 4], all[i + 5], all[i + 6], all[i + 7], all[i + 8]);
    };
  }
  const acc = accumulator();
  each((...v) => addTriangle(acc, ...v));
  return finish(acc, each);
}

/** A 3MF file's fingerprint over all its meshes (as stored, without plate placement), or null. */
function threeMfSignature(buffer) {
  const unzipped = fflate.unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
    filter: (file) => file.name.toLowerCase().endsWith('.model')
  });
  const decoder = new TextDecoder();
  const meshes = Object.keys(unzipped)
    .sort()
    .map((name) => extractMeshFromXml(decoder.decode(unzipped[name])));
  /** @param {(...v: number[]) => void} fn */
  const each = (fn) => {
    for (const { positions, indices } of meshes) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i] * 3;
        const b = indices[i + 1] * 3;
        const c = indices[i + 2] * 3;
        fn(
          positions[a],
          positions[a + 1],
          positions[a + 2],
          positions[b],
          positions[b + 1],
          positions[b + 2],
          positions[c],
          positions[c + 1],
          positions[c + 2]
        );
      }
    }
  };
  const acc = accumulator();
  each((...v) => addTriangle(acc, ...v));
  return finish(acc, each);
}

/** The fingerprint of a model file's contents by its extension (.stl, .3mf); null for other types. */
function geometrySignature(buffer, extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === '.stl') return stlSignature(buffer);
  if (ext === '.3mf') return threeMfSignature(buffer);
  return null;
}

/** How far measurements may differ for "the same shape at another resolution". */
const SIMILAR = { volume: 0.04, spread: 0.025, shape: 0.15 };

const relativeGap = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);

/**
 * True when two models' measurements ({ volume, spreads, hand, shape }) say the same design,
 * whatever its mesh resolution: volume within 4% and each spread within 2.5% (a coarser mesh cuts
 * corners off curves), the shape histograms within 0.15 (sum of differences; different shapes are
 * 0.35 and more apart), and the same handedness (or one too symmetric to tell). A part a few
 * percent bigger looks the same as a coarser mesh, and so do models that differ only in small
 * details: the Duplicates page says to check before deleting. Extremely coarse meshes (a
 * 12-sided cylinder) are too far off to match.
 */
function similarShape(a, b) {
  if (!a || !b || !Array.isArray(a.spreads) || !Array.isArray(b.spreads) || !Array.isArray(a.shape) || !Array.isArray(b.shape)) return false;
  if (a.hand && b.hand && a.hand !== b.hand) return false;
  if (relativeGap(a.volume, b.volume) > SIMILAR.volume) return false;
  for (let i = 0; i < 3; i++) if (relativeGap(a.spreads[i], b.spreads[i]) > SIMILAR.spread) return false;
  let distance = 0;
  for (let i = 0; i < a.shape.length; i++) distance += Math.abs(a.shape[i] - (b.shape[i] || 0));
  return distance <= SIMILAR.shape;
}

module.exports = { SIMILAR, eigenSymmetric, geometrySignature, similarShape, stlSignature, threeMfSignature };
