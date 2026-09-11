/* ═══════════════════════════════════════════════════════════════
   occt.js — STEP / IGES support via an in-browser geometry kernel

   STEP and IGES describe curved B-rep surfaces, not triangles, so
   they cannot be measured the way STL can. This module lazy-loads
   OpenCascade compiled to WebAssembly (occt-import-js, LGPL-2.1 —
   free for commercial use as a separate library), tessellates the
   model into a triangle mesh IN THE BROWSER, and hands the mesh to
   the same measuring pipeline used for STL.

   The file never leaves the page. The kernel (~7.6 MB) is fetched
   from /vendor/ once and then cached by the browser.

   Public API:  window.OcctBridge.measure(arrayBuffer, fileName, onStatus)
                -> Promise<result>   (same shape as Geometry.measure)
   ═══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var KERNEL_URL = 'vendor/occt-import-js.js';
  var MAX_BYTES = 60 * 1024 * 1024;

  /* Tessellation quality. 0.1 mm linear deflection = plenty accurate for
     pricing without exploding the triangle count on big parts. */
  var TESS_PARAMS = { linearUnit: 'millimeter', linearDeflection: 0.1, angularDeflection: 0.3 };

  var libPromise = null;
  var kernel = null;

  /* file:// pages cannot fetch the .wasm (browser security), but <script>
     tags still work there — so for local double-click previews we load the
     kernel as a base64 JS bundle and hand the bytes to Emscripten directly.
     Over http(s) the normal .wasm fetch path is used instead. */
  function decodeB64(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function loadWasmBinary() {
    return new Promise(function (resolve, reject) {
      if (typeof global.OCCT_WASM_B64 === 'string') {
        return resolve(decodeB64(global.OCCT_WASM_B64));
      }
      var s = document.createElement('script');
      s.src = 'vendor/occt-wasm-b64.js';
      s.onload = function () {
        if (typeof global.OCCT_WASM_B64 === 'string') resolve(decodeB64(global.OCCT_WASM_B64));
        else reject(new Error('kernel-unavailable'));
      };
      s.onerror = function () { reject(new Error('kernel-unavailable')); };
      document.head.appendChild(s);
    });
  }

  function loadKernel(onStatus) {
    if (kernel) return Promise.resolve(kernel);
    if (!libPromise) {
      libPromise = new Promise(function (resolve, reject) {
        if (typeof global.occtimportjs === 'function') { return boot(); }
        var script = document.createElement('script');
        script.src = KERNEL_URL;
        script.onload = boot;
        script.onerror = function () { libPromise = null; reject(new Error('kernel-unavailable')); };
        document.head.appendChild(script);

        function boot() {
          if (typeof global.occtimportjs !== 'function') {
            libPromise = null; return reject(new Error('kernel-unavailable'));
          }
          if (onStatus) onStatus('kernel-init');
          var isFile = location.protocol === 'file:';
          var opts = { locateFile: function (f) { return 'vendor/' + f; } };
          var start = isFile
            ? loadWasmBinary().then(function (bin) { opts.wasmBinary = bin; })
            : Promise.resolve();
          start.then(function () {
            return global.occtimportjs(opts);
          })
            .then(function (mod) { kernel = mod; resolve(mod); })
            .catch(function (err) { libPromise = null; reject(err); });
        }
      });
    }
    return libPromise;
  }

  function readStep(mod, bytes) {
    /* Params object first; a very old kernel build may reject it. */
    try {
      var withParams = mod.ReadStepFile(bytes, TESS_PARAMS);
      if (withParams && withParams.success) return withParams;
    } catch (e) { /* fall through */ }
    return mod.ReadStepFile(bytes, null);
  }

  /* Curvature proxy: a pure box tessellates to a handful of triangles no
     matter its size, so triangles-per-mm-of-diagonal separates prismatic
     plate work from fillet/surface-heavy work. */
  function complexity(diagMm, triangles) {
    if (!isFinite(diagMm) || diagMm < 1) return 'low';
    var perMm = triangles / diagMm;
    if (perMm > 150) return 'high';
    if (perMm > 40) return 'medium';
    return 'low';
  }

  function measure(arrayBuffer, fileName, onStatus) {
    return new Promise(function (resolve) {
      if (!arrayBuffer || !arrayBuffer.byteLength) {
        return resolve({ ok: false, error: 'unreadable', format: 'STEP', fileName: fileName });
      }
      if (arrayBuffer.byteLength > MAX_BYTES) {
        return resolve({ ok: false, error: 'too-large', format: 'STEP', fileName: fileName });
      }

      loadKernel(onStatus).then(function (mod) {
        var bytes = new Uint8Array(arrayBuffer);
        var res;
        try { res = readStep(mod, bytes); }
        catch (err) { return resolve({ ok: false, error: 'unreadable', format: 'STEP', fileName: fileName }); }

        if (!res || !res.success || !res.meshes || !res.meshes.length) {
          return resolve({ ok: false, error: 'no-geometry', format: 'STEP', fileName: fileName });
        }

        /* Merge every solid of the assembly into one measurement. Volumes
           sum because separate solids do not overlap in a sane model. */
        var acc = { positions: [], indices: [], offset: 0, solids: 0 };
        for (var m = 0; m < res.meshes.length; m++) {
          var mesh = res.meshes[m];
          var pos = mesh.attributes && mesh.attributes.position && mesh.attributes.position.array;
          var idx = mesh.index && mesh.index.array;
          if (!pos || !idx || idx.length < 3) continue;
          for (var p = 0; p < pos.length; p++) acc.positions.push(pos[p]);
          for (var t = 0; t < idx.length; t++) acc.indices.push(idx[t] + acc.offset);
          acc.offset += pos.length / 3;
          acc.solids++;
        }
        if (!acc.indices.length) {
          return resolve({ ok: false, error: 'no-geometry', format: 'STEP', fileName: fileName });
        }

        var out = global.Geometry.measureMesh(acc.positions, acc.indices, {
          format: 'STEP',
          fileName: fileName,
          triangleCount: acc.indices.length / 3
        });
        if (out && out.ok) {
          out.solids = acc.solids;
          out.complexity = complexity(Math.sqrt(out.bbox.x * out.bbox.x +
                                                out.bbox.y * out.bbox.y +
                                                out.bbox.z * out.bbox.z), out.triangles);
          out.units = 'mm'; /* kernel normalises to millimetres */
        }
        resolve(out);
      }).catch(function () {
        resolve({ ok: false, error: 'kernel-unavailable', format: 'STEP', fileName: fileName });
      });
    });
  }

  global.OcctBridge = { measure: measure, isReady: function () { return !!kernel; } };
})(window);
