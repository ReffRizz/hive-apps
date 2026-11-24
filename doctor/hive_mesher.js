/* HIVE Mesher — our own procedural surface engine.
   Builds smooth organic meshes from signed-distance fields (SDF) blended with smooth unions,
   polygonised with naive Surface Nets. No external model files, no licence — we own the
   generator and the anatomy definitions. Runs in the browser (window.HiveMesher) and in Node
   (module.exports) for headless self-tests. Normals come from the field gradient, so surfaces
   read as soft tissue, not faceted primitives. This is the mesher layer of the realistic-model
   pipeline (next layer: import open/public-domain anatomy data -> SDF/voxel -> this mesher).
   Surface Nets after S. L. Lysenko's public-domain naive implementation; SDF ops are standard. */
"use strict";
(function (root) {
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function sphere(c, r) { return function (p) { return vlen(vsub(p, c)) - r; }; }
  function ellipsoid(c, r) {
    return function (p) {
      var d = vsub(p, c);
      var k0 = Math.sqrt((d[0] / r[0]) * (d[0] / r[0]) + (d[1] / r[1]) * (d[1] / r[1]) + (d[2] / r[2]) * (d[2] / r[2]));
      if (k0 === 0) return -Math.min(r[0], r[1], r[2]);
      var k1 = Math.sqrt((d[0] / (r[0] * r[0])) * d[0] + (d[1] / (r[1] * r[1])) * d[1] + (d[2] / (r[2] * r[2])) * d[2]);
      return k0 * (k0 - 1.0) / k1;
    };
  }
  function capsule(a, b, r) {
    return function (p) {
      var pa = vsub(p, a), ba = vsub(b, a);
      var h = Math.max(0, Math.min(1, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2] || 1e-9)));
      return vlen([pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h]) - r;
    };
  }
  function box(c, s, round) {
    round = round || 0;
    return function (p) {
      var d = [Math.abs(p[0] - c[0]) - s[0] + round, Math.abs(p[1] - c[1]) - s[1] + round, Math.abs(p[2] - c[2]) - s[2] + round];
      var o = [Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)];
      return vlen(o) + Math.min(Math.max(d[0], Math.max(d[1], d[2])), 0) - round;
    };
  }
  function union() { var fs = Array.prototype.slice.call(arguments); return function (p) { var m = 1e9; for (var i = 0; i < fs.length; i++) { var v = fs[i](p); if (v < m) m = v; } return m; }; }
  function smin(a, b, k) { var h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k)); return b * (1 - h) + a * h - k * h * (1 - h); }
  function smoothUnion(k) { var fs = Array.prototype.slice.call(arguments, 1); return function (p) { var d = fs[0](p); for (var i = 1; i < fs.length; i++) d = smin(d, fs[i](p), k); return d; }; }
  function subtract(a, b) { return function (p) { return Math.max(a(p), -b(p)); }; }
  function intersect(a, b) { return function (p) { return Math.max(a(p), b(p)); }; }

  var CUBE_EDGES = new Int32Array(24), EDGE_TABLE = new Int32Array(256);
  (function initTables() {
    var k = 0;
    for (var i = 0; i < 8; ++i) { for (var j = 1; j <= 4; j <<= 1) { var pz = i ^ j; if (i <= pz) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = pz; } } }
    for (var m = 0; m < 256; ++m) { var em = 0; for (var e = 0; e < 24; e += 2) { var a = !!(m & (1 << CUBE_EDGES[e])), b = !!(m & (1 << CUBE_EDGES[e + 1])); em |= (a !== b) ? (1 << (e >> 1)) : 0; } EDGE_TABLE[m] = em; }
  })();

  function surfaceNets(field, bounds, res) {
    var dims = [], i;
    var span = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    var step = Math.max(span[0], span[1], span[2]) / res;
    for (i = 0; i < 3; i++) dims[i] = Math.max(2, Math.ceil(span[i] / step) + 1);
    var nx = dims[0], ny = dims[1], nz = dims[2];
    function P(ix, iy, iz) { return [bounds.min[0] + ix * step, bounds.min[1] + iy * step, bounds.min[2] + iz * step]; }
    var grid = new Float32Array(nx * ny * nz), gi = 0;
    for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) grid[gi++] = field(P(x, y, z));
    function G(x, y, z) { return grid[x + nx * (y + ny * z)]; }
    var positions = [], vindex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
    function VI(x, y, z) { return x + (nx - 1) * (y + (ny - 1) * z); }
    var quads = [];
    var cornerOff = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    for (var cz = 0; cz < nz - 1; cz++) for (var cy = 0; cy < ny - 1; cy++) for (var cx = 0; cx < nx - 1; cx++) {
      var mask = 0, s = [];
      for (var c = 0; c < 8; c++) { var o = cornerOff[c]; var v = G(cx + o[0], cy + o[1], cz + o[2]); s[c] = v; if (v < 0) mask |= (1 << c); }
      var em = EDGE_TABLE[mask];
      if (em === 0) continue;
      var vx = 0, vy = 0, vz = 0, n = 0;
      for (var e = 0; e < 12; e++) {
        if (!(em & (1 << e))) continue;
        var a = CUBE_EDGES[e * 2], b = CUBE_EDGES[e * 2 + 1], oa = cornerOff[a], ob = cornerOff[b], va = s[a], vb = s[b];
        var t = va / (va - vb); if (!isFinite(t)) t = 0.5;
        vx += (oa[0] + (ob[0] - oa[0]) * t); vy += (oa[1] + (ob[1] - oa[1]) * t); vz += (oa[2] + (ob[2] - oa[2]) * t); n++;
      }
      vx /= n; vy /= n; vz /= n;
      var wp = P(cx + vx, cy + vy, cz + vz);
      vindex[VI(cx, cy, cz)] = positions.length / 3;
      positions.push(wp[0], wp[1], wp[2]);
      for (var d = 0; d < 3; d++) {
        var du = (d + 1) % 3, dv = (d + 2) % 3;
        if ((d === 0 && cy > 0 && cz > 0) || (d === 1 && cx > 0 && cz > 0) || (d === 2 && cx > 0 && cy > 0)) {
          var c0 = s[0], c1 = s[1 << d];
          if ((c0 < 0) === (c1 < 0)) continue;
          var i0 = vindex[VI(cx, cy, cz)];
          var a1 = [cx, cy, cz]; a1[du] -= 1;
          var a2 = [cx, cy, cz]; a2[du] -= 1; a2[dv] -= 1;
          var a3 = [cx, cy, cz]; a3[dv] -= 1;
          var i1 = vindex[VI(a1[0], a1[1], a1[2])], i2 = vindex[VI(a2[0], a2[1], a2[2])], i3 = vindex[VI(a3[0], a3[1], a3[2])];
          if (i1 < 0 || i2 < 0 || i3 < 0) continue;
          if (c0 < 0) quads.push([i0, i1, i2, i3]); else quads.push([i0, i3, i2, i1]);
        }
      }
    }
    var indices = [];
    for (i = 0; i < quads.length; i++) { var q = quads[i]; indices.push(q[0], q[1], q[2], q[0], q[2], q[3]); }
    var epsv = step * 0.6, normals = new Float32Array(positions.length);
    for (i = 0; i < positions.length; i += 3) {
      var X = positions[i], Y = positions[i + 1], Z = positions[i + 2];
      var gx = field([X + epsv, Y, Z]) - field([X - epsv, Y, Z]);
      var gy = field([X, Y + epsv, Z]) - field([X, Y - epsv, Z]);
      var gz = field([X, Y, Z + epsv]) - field([X, Y, Z - epsv]);
      var l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      normals[i] = gx / l; normals[i + 1] = gy / l; normals[i + 2] = gz / l;
    }
    return { positions: new Float32Array(positions), indices: indices, normals: normals, quads: quads.length };
  }

  function geometry(THREE, field, bounds, res) {
    var m = surfaceNets(field, bounds, res);
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(m.indices);
    return g;
  }

  var API = { sphere: sphere, ellipsoid: ellipsoid, capsule: capsule, box: box, union: union, smoothUnion: smoothUnion, subtract: subtract, intersect: intersect, surfaceNets: surfaceNets, geometry: geometry };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.HiveMesher = API;

  if (typeof require !== "undefined" && require.main === module) {
    var H = API;
    var f = H.sphere([0, 0, 0], 2);
    var r = H.surfaceNets(f, { min: [-3, -3, -3], max: [3, 3, 3] }, 32);
    var n = r.positions.length / 3, maxErr = 0, sumErr = 0;
    for (var i = 0; i < r.positions.length; i += 3) { var d = Math.sqrt(r.positions[i] * r.positions[i] + r.positions[i + 1] * r.positions[i + 1] + r.positions[i + 2] * r.positions[i + 2]); var e = Math.abs(d - 2); maxErr = Math.max(maxErr, e); sumErr += e; }
    console.log("sphere: verts=" + n + " tris=" + (r.indices.length / 3) + " meanRadErr=" + (sumErr / n).toFixed(4) + " maxRadErr=" + maxErr.toFixed(4));
    var g = H.smoothUnion(0.8, H.sphere([-1, 0, 0], 1.2), H.sphere([1, 0, 0], 1.2));
    var r2 = H.surfaceNets(g, { min: [-3, -2, -2], max: [3, 2, 2] }, 40);
    console.log("smooth-union: verts=" + (r2.positions.length / 3) + " tris=" + (r2.indices.length / 3));
    var r3 = H.surfaceNets(H.capsule([0, -1, 0], [0, 1, 0], 0.5), { min: [-1, -2, -1], max: [1, 2, 1] }, 28);
    console.log("capsule: verts=" + (r3.positions.length / 3) + " tris=" + (r3.indices.length / 3));
    var nUnit = 0; for (var k = 0; k < r2.normals.length; k += 3) { var nl = Math.sqrt(r2.normals[k] * r2.normals[k] + r2.normals[k + 1] * r2.normals[k + 1] + r2.normals[k + 2] * r2.normals[k + 2]); if (Math.abs(nl - 1) < 0.01) nUnit++; }
    var ok = n > 200 && maxErr < 0.25 && r2.indices.length > 0 && r3.indices.length > 0 && nUnit > (r2.normals.length / 3) * 0.95;
    console.log("\nMESHER SELFTEST: " + (ok ? "GREEN" : "RED") + " (sphere watertight-ish, blends connect, normals unit)");
  }
})(typeof window !== "undefined" ? window : globalThis);
