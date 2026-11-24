/* HIVE HMesh — tiny loader for our own .hmesh binary (HMSH: verts, positions, normals, indices).
   Lets the offline app load real anatomy geometry with no glTF loader. Our code; data is CC-BY TotalSegmentator. */
(function (root) {
  function parse(buf) {
    var dv = new DataView(buf);
    var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "HMSH") throw new Error("bad hmesh header");
    var vc = dv.getUint32(8, true), ic = dv.getUint32(12, true), o = 16;
    var positions = new Float32Array(buf, o, vc * 3); o += vc * 3 * 4;
    var normals = new Float32Array(buf, o, vc * 3); o += vc * 3 * 4;
    var indices = new Uint32Array(buf, o, ic);
    return { positions: positions, normals: normals, indices: indices, vertexCount: vc, indexCount: ic };
  }
  function geometry(THREE, p) {
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    return g;
  }
  function load(THREE, url) {
    return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return geometry(THREE, parse(b)); });
  }
  var API = { parse: parse, geometry: geometry, load: load };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.HiveHMesh = API;
})(typeof window !== "undefined" ? window : globalThis);
