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
 * The same design meshed at another resolution is a different fingerprint.
 */

const fflate = require('fflate');
const { classifyStlBuffer } = require('../../stl-sanity');
const { extractMeshFromXml } = require('../../threemf-mesh-extract');

/** Four significant figures, as text ("1.235e+3"), so near-equal values give the same key. */
const sig = (value) => (Number.isFinite(value) && value !== 0 ? Number(value).toPrecision(4) : '0');

/** Running sums over triangles: area, signed volume, and area-weighted moments of triangle centres. */
function accumulator() {
  return { tris: 0, area: 0, volume: 0, m: [0, 0, 0], mm: [0, 0, 0, 0, 0, 0], points: [] };
}

function addTriangle(acc, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax; const uy = by - ay; const uz = bz - az;
  const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
  const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  acc.tris++;
  acc.area += area;
  acc.volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  if (!area) return;
  const px = (ax + bx + cx) / 3; const py = (ay + by + cy) / 3; const pz = (az + bz + cz) / 3;
  acc.m[0] += area * px; acc.m[1] += area * py; acc.m[2] += area * pz;
  acc.mm[0] += area * px * px; acc.mm[1] += area * py * py; acc.mm[2] += area * pz * pz;
  acc.mm[3] += area * px * py; acc.mm[4] += area * px * pz; acc.mm[5] += area * py * pz;
  acc.points.push(px, py, pz, area);
}

/** Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi rotations). */
function eigenSymmetric(a) {
  const m = [[a[0][0], a[0][1], a[0][2]], [a[1][0], a[1][1], a[1][2]], [a[2][0], a[2][1], a[2][2]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(m[0][1]) + Math.abs(m[0][2]) + Math.abs(m[1][2]);
    if (off < 1e-14 * (Math.abs(m[0][0]) + Math.abs(m[1][1]) + Math.abs(m[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(m[p][q]) < 1e-300) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const mkp = m[k][p]; const mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p][k]; const mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p]; const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((i) => ({ value: m[i][i], vector: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.value - x.value);
}

/** The fingerprint from the running sums: { signature, triangles, area, volume }, or null for no surface. */
function finish(acc) {
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
  const skews = axes.map((axis) => {
    let s = 0;
    for (let i = 0; i < acc.points.length; i += 4) {
      const d = (acc.points[i] - c[0]) * axis.vector[0] + (acc.points[i + 1] - c[1]) * axis.vector[1] + (acc.points[i + 2] - c[2]) * axis.vector[2];
      s += acc.points[i + 3] * d * d * d;
    }
    return s / (A * scale * scale * scale);
  });
  const SKEW_MIN = 1e-4;
  // Two leaning axes are enough: the third follows from them.
  const leaning = skews.filter((s) => Math.abs(s) > SKEW_MIN).length;
  let hand = 0;
  if (leaning >= 2) {
    const e = axes.map((axis, i) => (skews[i] < 0 ? axis.vector.map((x) => -x) : axis.vector));
    if (Math.abs(skews[2]) <= SKEW_MIN) e[2] = [e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2], e[0][0] * e[1][1] - e[0][1] * e[1][0]];
    else if (Math.abs(skews[1]) <= SKEW_MIN) e[1] = [e[2][1] * e[0][2] - e[2][2] * e[0][1], e[2][2] * e[0][0] - e[2][0] * e[0][2], e[2][0] * e[0][1] - e[2][1] * e[0][0]];
    else if (Math.abs(skews[0]) <= SKEW_MIN) e[0] = [e[1][1] * e[2][2] - e[1][2] * e[2][1], e[1][2] * e[2][0] - e[1][0] * e[2][2], e[1][0] * e[2][1] - e[1][1] * e[2][0]];
    const det = e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) - e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0]) + e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]);
    hand = det > 0 ? 1 : -1;
  }
  const volume = Math.abs(acc.volume);
  return {
    signature: [acc.tris, sig(A), sig(volume), ...spreads.map(sig), hand].join(':'),
    triangles: acc.tris,
    area: A,
    volume
  };
}

/** An STL file's fingerprint (binary or ASCII), or null for one with no surface. */
function stlSignature(buffer) {
  const kind = classifyStlBuffer(buffer);
  const acc = accumulator();
  if (kind === 'binary') {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const count = view.getUint32(80, true);
    for (let i = 0, offset = 84; i < count && offset + 50 <= buffer.byteLength; i++, offset += 50) {
      const f = (k) => view.getFloat32(offset + 12 + k * 4, true);
      addTriangle(acc, f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8));
    }
  } else {
    const text = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('latin1');
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const v = [];
    let match;
    while ((match = re.exec(text)) !== null) {
      v.push(Number(match[1]), Number(match[2]), Number(match[3]));
      if (v.length === 9) {
        addTriangle(acc, ...v);
        v.length = 0;
      }
    }
  }
  return finish(acc);
}

/** A 3MF file's fingerprint over all its meshes (as stored, without plate placement), or null. */
function threeMfSignature(buffer) {
  const unzipped = fflate.unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
    filter: (file) => file.name.toLowerCase().endsWith('.model')
  });
  const decoder = new TextDecoder();
  const acc = accumulator();
  for (const name of Object.keys(unzipped).sort()) {
    const { positions, indices } = extractMeshFromXml(decoder.decode(unzipped[name]));
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i] * 3; const b = indices[i + 1] * 3; const c = indices[i + 2] * 3;
      addTriangle(acc, positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2], positions[c], positions[c + 1], positions[c + 2]);
    }
  }
  return finish(acc);
}

/** The fingerprint of a model file's contents by its extension (.stl, .3mf); null for other types. */
function geometrySignature(buffer, extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === '.stl') return stlSignature(buffer);
  if (ext === '.3mf') return threeMfSignature(buffer);
  return null;
}

module.exports = { eigenSymmetric, geometrySignature, stlSignature, threeMfSignature };
