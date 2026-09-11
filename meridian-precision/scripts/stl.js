/* ═══════════════════════════════════════════════════════════════
   stl.js — client-side geometry measurement
   Reads STL (binary + ASCII) and OBJ straight from the browser.
   Nothing is uploaded; nothing leaves the page.

   Outputs raw numbers in *file units* — the caller applies the
   unit scale chosen by the user, because STL carries no units.

   Public API:  window.Geometry.measure(file) -> Promise<result>
   ═══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var MAX_BYTES = 60 * 1024 * 1024;      // refuse anything bigger than this
  var CLOSED_TEST_LIMIT = 60000;         // edge-pairing test only below this
  var CHUNK = 20000;                     // triangles per yield

  function yieldToUI() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function isBinarySTL(buffer) {
    if (buffer.byteLength < 84) return false;
    var declared = new DataView(buffer).getUint32(80, true);
    // the only reliable signature: declared triangle count matches file length
    return 84 + declared * 50 === buffer.byteLength;
  }

  /* ── accumulator ── */
  function newAcc() {
    return {
      minx: Infinity, miny: Infinity, minz: Infinity,
      maxx: -Infinity, maxy: -Infinity, maxz: -Infinity,
      volume: 0,
      area: 0,
      triangles: 0,
      degenerate: 0,
      edges: null
    };
  }

  function addTriangle(acc, ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (ax < acc.minx) acc.minx = ax;
    if (ay < acc.miny) acc.miny = ay;
    if (az < acc.minz) acc.minz = az;
    if (bx < acc.minx) acc.minx = bx;
    if (by < acc.miny) acc.miny = by;
    if (bz < acc.minz) acc.minz = bz;
    if (cx < acc.minx) acc.minx = cx;
    if (cy < acc.miny) acc.miny = cy;
    if (cz < acc.minz) acc.minz = cz;

    if (ax > acc.maxx) acc.maxx = ax;
    if (ay > acc.maxy) acc.maxy = ay;
    if (az > acc.maxz) acc.maxz = az;
    if (bx > acc.maxx) acc.maxx = bx;
    if (by > acc.maxy) acc.maxy = by;
    if (bz > acc.maxz) acc.maxz = bz;
    if (cx > acc.maxx) acc.maxx = cx;
    if (cy > acc.maxy) acc.maxy = cy;
    if (cz > acc.maxz) acc.maxz = cz;

    acc.triangles++;

    // signed volume of the tetrahedron (origin, a, b, c)
    acc.volume += (ax * (by * cz - bz * cy)
                 - ay * (bx * cz - bz * cx)
                 + az * (bx * cy - by * cx)) / 6;

    // triangle area from the cross product
    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) {
      acc.degenerate++;
      return;
    }
    acc.area += len / 2;

    if (acc.edges) {
      addEdge(acc.edges, ax, ay, az, bx, by, bz);
      addEdge(acc.edges, bx, by, bz, cx, cy, cz);
      addEdge(acc.edges, cx, cy, cz, ax, ay, az);
    }
  }

  /* edge pairing: a watertight mesh has every edge shared by exactly two faces */
  function edgeKey(x1, y1, z1, x2, y2, z2) {
    var q = 1e4;
    var a = [Math.round(x1 * q), Math.round(y1 * q), Math.round(z1 * q)];
    var b = [Math.round(x2 * q), Math.round(y2 * q), Math.round(z2 * q)];
    var swap = (a[0] > b[0]) || (a[0] === b[0] && a[1] > b[1]) ||
               (a[0] === b[0] && a[1] === b[1] && a[2] > b[2]);
    var lo = swap ? b : a;
    var hi = swap ? a : b;
    return lo[0] + '|' + lo[1] + '|' + lo[2] + '>' + hi[0] + '|' + hi[1] + '|' + hi[2];
  }

  function addEdge(map, x1, y1, z1, x2, y2, z2) {
    var k = edgeKey(x1, y1, z1, x2, y2, z2);
    map.set(k, (map.get(k) || 0) + 1);
  }

  function finish(acc, meta) {
    if (!isFinite(acc.minx)) {
      return { ok: false, error: 'no-geometry', format: meta.format };
    }
    var dx = acc.maxx - acc.minx;
    var dy = acc.maxy - acc.miny;
    var dz = acc.maxz - acc.minz;
    var absVolume = Math.abs(acc.volume);

    var out = {
      ok: true,
      kind: 'mesh',
      format: meta.format,
      bbox: { x: dx, y: dy, z: dz },
      bboxVolume: dx * dy * dz,
      volume: absVolume,
      area: acc.area,
      triangles: acc.triangles,
      degenerate: acc.degenerate,
      inverted: acc.volume < 0,
      closed: null,
      triangleCount: meta.triangleCount || acc.triangles,
      fileName: meta.fileName
    };

    if (acc.edges) {
      var open = 0;
      acc.edges.forEach(function (count) { if (count !== 2) open++; });
      out.closed = open === 0;
      out.openEdges = open;
    }
    return out;
  }

  /* ── binary STL ── */
  function parseBinarySTL(buffer, meta) {
    var view = new DataView(buffer);
    var total = view.getUint32(80, true);
    var acc = newAcc();
    if (total <= CLOSED_TEST_LIMIT) acc.edges = new Map();

    var i = 0;
    function step() {
      var end = Math.min(i + CHUNK, total);
      for (; i < end; i++) {
        var o = 84 + i * 50 + 12;                       // skip the normal
        var ax = view.getFloat32(o, true),      ay = view.getFloat32(o + 4, true),  az = view.getFloat32(o + 8, true);
        var bx = view.getFloat32(o + 12, true), by = view.getFloat32(o + 16, true), bz = view.getFloat32(o + 20, true);
        var cx = view.getFloat32(o + 24, true), cy = view.getFloat32(o + 28, true), cz = view.getFloat32(o + 32, true);
        addTriangle(acc, ax, ay, az, bx, by, bz, cx, cy, cz);
      }
      if (i < total) {
        if (meta.onProgress) meta.onProgress(i / total);
        return yieldToUI().then(step);
      }
      return finish(acc, meta);
    }
    return step();
  }

  /* ── ASCII STL ── */
  function parseAsciiSTL(text, meta) {
    var re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    var acc = newAcc();
    var buffer = [];
    var m;
    var pending = 0;
    var matched = 0;

    while ((m = re.exec(text)) !== null) {
      buffer.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      pending++;
      matched++;
      if (pending === 3) {
        addTriangle(acc, buffer[0], buffer[1], buffer[2],
                         buffer[3], buffer[4], buffer[5],
                         buffer[6], buffer[7], buffer[8]);
        buffer.length = 0;
        pending = 0;
      }
    }
    if (!matched) {
      // no "vertex" keywords — the file is probably a plain coordinate dump
      return Promise.resolve({ ok: false, error: 'no-geometry', format: 'ascii-stl' });
    }
    if (acc.triangles <= CLOSED_TEST_LIMIT) {
      acc.edges = new Map();
      var re2 = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
      var b2 = [];
      var p2 = 0;
      var m2;
      while ((m2 = re2.exec(text)) !== null) {
        b2.push(parseFloat(m2[1]), parseFloat(m2[2]), parseFloat(m2[3]));
        p2++;
        if (p2 === 3) {
          addEdge(acc.edges, b2[0], b2[1], b2[2], b2[3], b2[4], b2[5]);
          addEdge(acc.edges, b2[3], b2[4], b2[5], b2[6], b2[7], b2[8]);
          addEdge(acc.edges, b2[6], b2[7], b2[8], b2[0], b2[1], b2[2]);
          b2.length = 0;
          p2 = 0;
        }
      }
    }
    return Promise.resolve(finish(acc, meta));
  }

  /* ── OBJ ── */
  function parseOBJ(text, meta) {
    var verts = [];      // flat xyz
    var acc = newAcc();
    var lines = text.split(/\r?\n/);
    var faces = [];
    var i, parts, idx;

    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charCodeAt(0) === 118 /* v */) {
        parts = line.trim().split(/\s+/);
        if (parts[0] === 'v') {
          verts.push(parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0);
        }
      } else if (line.charCodeAt(0) === 102 /* f */) {
        parts = line.trim().split(/\s+/);
        if (parts[0] === 'f') {
          var poly = [];
          for (var p = 1; p < parts.length; p++) {
            idx = parseInt(parts[p].split('/')[0], 10);
            if (!isNaN(idx)) {
              // OBJ indices are 1-based; negatives count back from the end
              poly.push(idx > 0 ? idx - 1 : (verts.length / 3) + idx);
            }
          }
          if (poly.length >= 3) faces.push(poly);
        }
      }
    }

    acc.edges = faces.length <= CLOSED_TEST_LIMIT ? new Map() : null;

    for (i = 0; i < faces.length; i++) {
      var f = faces[i];
      // fan triangulation
      for (var k = 1; k + 1 < f.length; k++) {
        var i0 = f[0] * 3, i1 = f[k] * 3, i2 = f[k + 1] * 3;
        if (i1 + 2 >= verts.length || i2 + 2 >= verts.length || i0 + 2 >= verts.length) continue;
        addTriangle(acc,
          verts[i0], verts[i0 + 1], verts[i0 + 2],
          verts[i1], verts[i1 + 1], verts[i1 + 2],
          verts[i2], verts[i2 + 1], verts[i2 + 2]);
      }
    }

    if (!faces.length) {
      // point cloud only — we can measure the envelope but not the solid
      var res = { ok: false, error: 'no-faces', format: 'obj', vertices: verts.length / 3 };
      if (verts.length) {
        var box = newAcc();
        for (var v = 0; v < verts.length; v += 3) {
          addTriangle(box, verts[v], verts[v + 1], verts[v + 2],
                           verts[v], verts[v + 1], verts[v + 2],
                           verts[v], verts[v + 1], verts[v + 2]);
        }
        res.bbox = {
          x: box.maxx - box.minx,
          y: box.maxy - box.miny,
          z: box.maxz - box.minz
        };
        res.estimated = true;
      }
      return Promise.resolve(res);
    }

    return Promise.resolve(finish(acc, meta));
  }

  /* ── entry point ── */
  function measure(file, onProgress) {
    return new Promise(function (resolve) {
      var name = file.name || '';
      var ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      var meta = { fileName: name, format: ext, onProgress: onProgress };

      if (file.size > MAX_BYTES) {
        resolve({ ok: false, error: 'too-large', format: ext, name: name });
        return;
      }

      if (ext === 'obj') {
        readText(file, function (text) {
          resolve(parseOBJ(text, meta));
        });
        return;
      }

      if (ext === 'stl') {
        readBuffer(file, function (buffer) {
          if (isBinarySTL(buffer)) {
            resolve(parseBinarySTL(buffer, meta));
          } else {
            var text;
            try {
              text = new TextDecoder('utf-8').decode(buffer);
            } catch (e) {
              text = '';
            }
            if (/facet|vertex/i.test(text.slice(0, 4096))) {
              resolve(parseAsciiSTL(text, meta));
            } else {
              resolve({ ok: false, error: 'unreadable', format: 'stl', name: name });
            }
          }
        });
        return;
      }

      // any other CAD format: we cannot measure it here, an engineer prices it
      resolve({ ok: false, error: 'needs-engineer', format: ext, name: name });
    });
  }

  /* ── indexed mesh (used by the STEP/IGES kernel bridge) ──
     positions: flat xyz array; indices: flat triangle index array.
     Units are whatever the caller passes — mm for STEP. */
  function measureIndexedMesh(positions, indices, meta) {
    var acc = newAcc();
    var tris = Math.floor(indices.length / 3);
    if (tris <= CLOSED_TEST_LIMIT) acc.edges = new Map();
    for (var i = 0; i + 2 < indices.length; i += 3) {
      var a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      addTriangle(acc,
        positions[a], positions[a + 1], positions[a + 2],
        positions[b], positions[b + 1], positions[b + 2],
        positions[c], positions[c + 1], positions[c + 2]);
    }
    return finish(acc, meta);
  }

  function readBuffer(file, cb) {
    var reader = new FileReader();
    reader.onload = function () { cb(reader.result); };
    reader.onerror = function () { cb(new ArrayBuffer(0)); };
    reader.readAsArrayBuffer(file);
  }

  function readText(file, cb) {
    var reader = new FileReader();
    reader.onload = function () { cb(String(reader.result || '')); };
    reader.onerror = function () { cb(''); };
    reader.readAsText(file);
  }

  global.Geometry = {
    measure: measure,
    measureMesh: measureIndexedMesh,
    _internal: { isBinarySTL: isBinarySTL, parseAsciiSTL: parseAsciiSTL, parseOBJ: parseOBJ }
  };
})(window);
