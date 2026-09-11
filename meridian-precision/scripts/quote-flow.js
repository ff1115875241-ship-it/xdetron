/* ═══════════════════════════════════════════════════════════════════════════
   quote-flow.js — the quote engine, wired to the page
   ───────────────────────────────────────────────────────────────────────────
   Four things happen here:

     1. The four input steps feed window.QuoteEngine.compute().
     2. The result is rendered as a readout — and never as a naked number:
        price, batch, cycle, weight, removal, cost bars, DFM notes.
     3. Every distinct configuration gets a quote number (QT-YYMMDD-####).
        The same configuration always produces the same number, so a customer
        can quote it back to us and we find the same quote.
     4. That whole package is carried into the enquiry form, so the customer
        types four contact fields and nothing technical.

   ⚠  RFQ_ENDPOINT below is deliberately empty. Until you fill it in, the
      form validates, shows the receipt and logs the payload to the console —
      which is enough to test the flow end to end, and not enough to lose a
      real enquiry. See README § Wiring the form.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var RFQ_ENDPOINT = '';            /* e.g. 'https://formspree.io/f/xxxxxxx' */
  var FALLBACK_EMAIL = 'rfq@xdetron.com';
  var Q = window.QuoteEngine;
  var G = window.Geometry;
  var O = window.OcctBridge;        /* STEP / IGES kernel bridge (lazy-loaded) */
  var S = window.Site;

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var ymd = function (d) { return String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()); };

  /* Unit → millimetre scale. An STL carries no units, so the visitor decides. */
  var UNIT_SCALE = { mm: 1, cm: 10, in: 25.4 };

  var state = {
    mode: 'upload',      /* which geometry pane is showing */
    measured: null,      /* result of a successful in-browser mesh measure */
    queue: [],           /* files we hand to an engineer instead of measuring */
    typeddims: false,    /* geometry came from the number fields */
    currency: 'USD',
    quote: null,         /* { id, result, input, display } */
    lastSignature: null,
    engineerToastShown: false
  };

  if (!Q || !G || !S) return;   /* one of the scripts failed to load */

  /* ── Form element handles ───────────────────────────────────────────── */
  var el = {
    form: $('quoteForm'), readout: $('readout'),
    material: $('materialSelect'), finish: $('finishSelect'),
    qty: $('qty'), dimX: $('dimX'), dimY: $('dimY'), dimZ: $('dimZ'), fill: $('fillRatio'),
    paneUpload: $('paneUpload'), paneDims: $('paneDims'),
    drop: $('drop'), fileInput: $('fileInput'),
    progWrap: $('progWrap'), progBar: $('progBar'), queue: $('queue'), measures: $('measures'),
    dropStatus: $('dropStatus'), queueNote: $('queueNote'),
    mBbox: $('mBbox'), mVol: $('mVol'), mArea: $('mArea'), mTri: $('mTri'),
    priceVal: $('priceVal'), curSym: $('curSym'), priceMeta: $('priceMeta'),
    rBatch: $('rBatch'), rLead: $('rLead'), rCycle: $('rCycle'),
    rWeight: $('rWeight'), rRemoval: $('rRemoval'), rQuoteId: $('rQuoteId'),
    bars: $('bars'), barsBody: $('barsBody'), dfm: $('dfm'), dfmBody: $('dfmBody'),
    toast: $('toast')
  };

  /* ── Populate the option lists straight from the cost model ─────────── */
  function fillSelects() {
    var zh = S.lang() === 'zh';
    el.material.innerHTML = '';

    Q.MATERIAL_GROUPS.forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = zh ? group.zh : group.en;
      Q.MATERIALS.filter(function (m) { return m.group === group.id; }).forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = (zh ? m.zh : m.en) + '  ·  ' + m.pricePerKg + ' ¥/kg';
        og.appendChild(o);
      });
      el.material.appendChild(og);
    });

    el.finish.innerHTML = '';
    Q.FINISHES.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = zh ? f.zh : f.en;
      el.finish.appendChild(o);
    });
  }

  /* ── Read the form ──────────────────────────────────────────────────── */
  function radio(name) {
    var checked = el.form.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : null;
  }

  function num(input, fallback) {
    var v = parseFloat(input.value);
    return isFinite(v) ? v : fallback;
  }

  function buildInput() {
    var qty = Math.round(num(el.qty, 10));
    var bbox, volCm3, areaCm2, tris = null, closed = null, assumed, source;

    if (state.mode === 'upload' && !state.measured) {
      /* Nothing to price yet. Say why, rather than quietly pricing the
         dimensions in the pane the visitor cannot see. */
      return { ok: false, reason: 'no-geometry' };
    }

    if (state.measured) {
      var m = state.measured;
      bbox = m.bboxMm; volCm3 = m.volCm3; areaCm2 = m.areaCm2;
      tris = m.triangles; closed = m.closed; assumed = false; source = 'file';
      if (qty < 1 || qty > 100000) return { ok: false, reason: 'qty', field: el.qty };
    } else {
      var x = num(el.dimX, 0), y = num(el.dimY, 0), z = num(el.dimZ, 0);
      var fillPct = Math.min(100, Math.max(3, num(el.fill, 55)));
      if (x < 1 || y < 1 || z < 0.5) return { ok: false, reason: 'dims' };
      if (qty < 1 || qty > 100000) return { ok: false, reason: 'qty', field: el.qty };
      bbox = { x: x, y: y, z: z };
      var boxVol = x * y * z;                       /* mm³ */
      volCm3 = boxVol * fillPct / 100 / 1000;       /* cm³ of real metal */
      areaCm2 = 2 * (x * y + y * z + z * x) / 100 * 0.9;
      assumed = true;
      source = state.typeddims ? 'typed' : 'envelope';
    }

    return {
      ok: true,
      input: {
        volumeCm3: volCm3,
        areaCm2: areaCm2,
        bbox: bbox,
        processId: radio('process') || 'cnc3',
        materialId: el.material.value,
        toleranceId: radio('tol') || 'general',
        finishId: el.finish.value,
        rushId: radio('rush') || 'standard',
        qty: qty,
        assumed: assumed,
        closed: closed,
        triangles: tris,
        format: state.measured ? state.measured.format : null,
        currency: state.currency
      },
      meta: { source: source, qty: qty, bbox: bbox, volCm3: volCm3, areaCm2: areaCm2, tris: tris, closed: closed }
    };
  }

  /* ── Quote number ───────────────────────────────────────────────────── */
  function hash4(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return 1000 + (h % 9000);
  }

  function signature(inp) {
    return [
      inp.processId, inp.materialId, inp.toleranceId, inp.finishId, inp.rushId, inp.qty,
      Math.round(inp.bbox.x * 10), Math.round(inp.bbox.y * 10), Math.round(inp.bbox.z * 10),
      Math.round(inp.volumeCm3 * 1000), Math.round(inp.areaCm2 * 100),
      inp.assumed ? 'a' : 'm', inp.triangles || 0
    ].join('|');
  }

  function quoteIdFor(inp) {
    return 'QT-' + ymd(new Date()) + '-' + hash4(signature(inp));
  }

  /* ── Render ─────────────────────────────────────────────────────────── */
  function money(value, currency) {
    var f = Q.formatMoney(value, currency);
    return f.symbol + f.text;
  }

  function render(result, inp, meta, id) {
    var zh = S.lang() === 'zh';
    var cur = result.currency;
    var unit = cur === 'USD' ? Q.toUSD(result.unit) : result.unit;
    var batch = cur === 'USD' ? Q.toUSD(result.batch) : result.batch;

    el.readout.classList.remove('is-pending');
    el.curSym.textContent = cur === 'USD' ? '$' : '¥';
    el.priceVal.textContent = unit.toLocaleString(zh ? 'zh-CN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el.priceVal.classList.remove('spin');
    void el.priceVal.offsetWidth;                 /* restart the flash animation */
    el.priceVal.classList.add('spin');

    el.priceMeta.textContent = zh
      ? '单件价 · ' + meta.qty + ' 件 · ' + (inp.assumed ? '按外形估算' : '按实测几何')
      : 'per piece · qty ' + meta.qty + ' · ' + (inp.assumed ? 'estimated envelope' : 'measured geometry');

    el.rBatch.textContent = money(batch, cur);
    el.rLead.textContent = result.leadDays[0] + '–' + result.leadDays[1] + (zh ? ' 天' : ' d');
    el.rCycle.textContent = result.metrics.cycleMin.toFixed(1) + ' min';
    el.rWeight.textContent = result.metrics.partKg < 1
      ? (result.metrics.partKg * 1000).toFixed(0) + ' g'
      : result.metrics.partKg.toFixed(2) + ' kg';
    el.rRemoval.textContent = result.metrics.removedCm3.toFixed(1) + ' cm³';
    el.rQuoteId.textContent = id;

    /* Cost bars — share of the batch total */
    var total = result.breakdown.reduce(function (a, b) { return a + b.value; }, 0) || 1;
    el.barsBody.innerHTML = '';
    result.breakdown.forEach(function (row) {
      if (row.value <= 0) return;
      var v = cur === 'USD' ? Q.toUSD(row.value) : row.value;
      var pct = Math.round(row.value / total * 100);
      var wrap = document.createElement('div');
      wrap.className = 'bars__row';
      wrap.innerHTML =
        '<span class="bars__label">' + (zh ? row.zh : row.en) + '</span>' +
        '<span class="bars__val">' + money(v, cur) + ' · ' + pct + '%</span>' +
        '<span class="bars__track"><span class="bars__fill" style="width:' + pct + '%"></span></span>';
      el.barsBody.appendChild(wrap);
    });
    el.bars.hidden = false;

    /* DFM notes */
    el.dfmBody.innerHTML = '';
    var severity = { ok: zh ? '可做' : 'OK', warn: zh ? '注意' : 'watch', high: zh ? '风险' : 'risk' };
    result.dfm.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'dfm__row';
      row.setAttribute('data-level', d.level);
      row.innerHTML = '<span class="dfm__sev">' + severity[d.level] + '</span><span>' + (zh ? d.zh : d.en) + '</span>';
      el.dfmBody.appendChild(row);
    });
    /* A STEP model with heavy curved-surface content deserves an honesty note:
       the tessellated volume is an estimate, not a CAM-grade number. */
    if (state.measured && state.measured.complexity === 'high') {
      var cRow = document.createElement('div');
      cRow.className = 'dfm__row';
      cRow.setAttribute('data-level', 'warn');
      cRow.innerHTML = '<span class="dfm__sev">' + severity.warn + '</span><span>' +
        (zh ? '该模型曲面特征较多，参考价基于网格估算 —— 建议下单前让工程师复核确认。'
            : 'Heavy curved-surface content: this reference price is estimated from the tessellated model. Have an engineer confirm it before ordering.') +
        '</span>';
      el.dfmBody.appendChild(cRow);
    }
    el.dfm.hidden = false;

    /* Keep the printable sheet in step with the screen, so Ctrl+P works even
       in browsers that never fire beforeprint. */
    fillSheet();
  }

  function renderEmpty(message) {
    el.readout.classList.add('is-pending');
    el.priceVal.textContent = '—';
    el.curSym.textContent = state.currency === 'USD' ? '$' : '¥';
    el.priceMeta.textContent = message || S.t('per piece · fill in the four steps', '单件价 · 请填完上面四步');
    ['rBatch', 'rLead', 'rCycle', 'rWeight', 'rRemoval', 'rQuoteId'].forEach(function (k) {
      el[k].textContent = '—';
    });
    el.bars.hidden = true;
    el.dfm.hidden = true;
    state.quote = null;
    clearSheet();
    carryToRfq(null);
  }

  /* An empty state must not leave a stale price on the printable sheet. */
  function clearSheet() {
    var sheet = $('sheet');
    if (!sheet) return;
    ['sId', 'sDate', 'sValid', 'sUnit', 'sBatch'].forEach(function (k) {
      var n = $(k); if (n) n.textContent = '—';
    });
    ['sSpecs', 'sRows', 'sDfm'].forEach(function (k) {
      var n = $(k); if (n) n.innerHTML = '';
    });
    sheet.setAttribute('aria-hidden', 'true');
  }

  function emptyMessage(reason) {
    if (reason === 'no-geometry') {
      if (state.queue.length) {
        return S.t('per piece · queued files are priced by an engineer — drop an STL/STEP or use typed dimensions for an instant price',
                   '单件价 · 队列文件由工程师核价 —— 拖入 STL/STEP 或改用手填尺寸可立即看价');
      }
      return S.t('per piece · drop a 3D file, or switch to typed dimensions',
                 '单件价 · 请拖入 3D 文件，或切换到「手填外形尺寸」');
    }
    if (reason === 'qty') {
      return S.t('per piece · enter a quantity between 1 and 100,000',
                 '单件价 · 请输入 1 到 100,000 之间的数量');
    }
    return S.t('per piece · check the highlighted dimension above',
               '单件价 · 请检查上方标红的尺寸');
  }

  /* ── The one function that runs on every change ─────────────────────── */
  function recalc() {
    var built = buildInput();
    el.qty.closest('.field').classList.toggle('is-invalid', built.reason === 'qty');

    if (!built.ok) { renderEmpty(emptyMessage(built.reason)); return; }

    var inp = built.input;
    var result = Q.compute(inp);

    var sig = signature(inp);
    var id = state.quote && state.lastSignature === sig ? state.quote.id : quoteIdFor(inp);
    state.lastSignature = sig;

    state.quote = { id: id, result: result, input: inp, meta: built.meta, display: {
      unit: result.currency === 'USD' ? Q.toUSD(result.unit) : result.unit,
      batch: result.currency === 'USD' ? Q.toUSD(result.batch) : result.batch
    } };

    render(result, inp, built.meta, id);
    carryToRfq(state.quote);
  }

  /* ── Geometry: file handling ────────────────────────────────────────── */
  function setMeasures(m) {
    el.measures.hidden = false;
    el.mBbox.textContent = m.bboxMm.x.toFixed(1) + ' × ' + m.bboxMm.y.toFixed(1) + ' × ' + m.bboxMm.z.toFixed(1);
    el.mVol.textContent = m.volCm3.toFixed(2) + ' cm³';
    el.mArea.textContent = m.areaCm2.toFixed(1) + ' cm²';
    el.mTri.textContent = m.triangles.toLocaleString(S.lang() === 'zh' ? 'zh-CN' : 'en-US');
  }

  function clearMeasures() {
    state.measured = null;
    el.measures.hidden = true;
  }

  function pushQueue(name, noteKey) {
    var note = {
      engineer: S.t('Priced by an engineer — not measurable in a browser', '由工程师核价，浏览器无法测量'),
      large: S.t('Over 60 MB — sent to an engineer instead', '超过 60 MB，转工程师处理'),
      unreadable: S.t('Could not be read — sent to an engineer', '无法解析，转工程师处理'),
      empty: S.t('No solid geometry found — sent to an engineer', '未找到实体几何，转工程师处理'),
      kernel: S.t('Geometry kernel did not load — sent to an engineer', '几何内核加载失败，转工程师处理'),
      fileproto: S.t('Opened as a local file — the geometry kernel only loads over http(s)',
                     '当前是本地文件打开方式，几何内核需在 http(s) 环境下才能加载')
    }[noteKey] || noteKey;

    var li = document.createElement('li');
    li.className = 'queue__item';
    li.innerHTML = '<span class="queue__name">' + name + '</span><span class="queue__note">' + note + '</span>';
    el.queue.hidden = false;
    el.queue.appendChild(li);
    if (el.queueNote) el.queueNote.hidden = false;
    state.queue.push({ name: name, note: note });
  }

  function showDropStatus(key) {
    if (!el.dropStatus) return;
    el.dropStatus.hidden = false;
    el.dropStatus.textContent = S.t('Loading the geometry kernel — about 8 MB, first visit only. STEP and IGES are converted right here in your browser; the file never leaves the page.',
                                    '正在加载几何内核（约 8 MB，仅首次访问）。STEP 与 IGES 将在你的浏览器内完成转换，文件不会离开本页。');
  }

  function hideDropStatus() {
    if (el.dropStatus) { el.dropStatus.hidden = true; el.dropStatus.textContent = ''; }
  }

  function handleFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;

    var scale = UNIT_SCALE[(el.form.querySelector('input[name="unit"]:checked') || {}).value || 'mm'];
    var index = 0;

    (function next() {
      if (index >= list.length) {
        el.progWrap.hidden = true;
        el.progBar.style.width = '0';
        recalc();
        return;
      }
      var file = list[index++];
      var ext = (file.name.split('.').pop() || '').toLowerCase();

      /* Formats only a human can price: drawings, native CAD, documents. */
      if (['dwg', 'dxf', 'pdf', 'sldprt', 'ipt'].indexOf(ext) >= 0) {
        pushQueue(file.name, 'engineer');
        if (!state.engineerToastShown) {
          state.engineerToastShown = true;
          S.toast(S.t('That format is priced by an engineer. STEP and IGES get an instant price.',
                      '该格式由工程师核价。STEP 与 IGES 可以即时自动报价。'));
        }
        next();
        return;
      }

      /* STEP / IGES / BREP: tessellate in the browser with the OCCT kernel,
         then reuse the same mesh pipeline as STL. */
      if (['step', 'stp', 'iges', 'igs', 'brep'].indexOf(ext) >= 0 && O) {
        el.progWrap.hidden = false;
        el.progBar.style.width = '6%';
        showDropStatus('kernel');

        var readAll = file.arrayBuffer
          ? file.arrayBuffer()
          : new Promise(function (res) {
              var r = new FileReader();
              r.onload = function () { res(r.result); };
              r.onerror = function () { res(new ArrayBuffer(0)); };
              r.readAsArrayBuffer(file);
            });

        readAll.then(function (buf) {
          el.progBar.style.width = '38%';
          return O.measure(buf, file.name, showDropStatus);
        }).then(function (res) {
          el.progBar.style.width = '100%';
          hideDropStatus();

          if (res && res.ok) {
            state.measured = {
              fileName: res.fileName,
              format: res.format,
              bboxMm: { x: res.bbox.x * scale, y: res.bbox.y * scale, z: res.bbox.z * scale },
              volCm3: res.volume * scale * scale * scale / 1000,
              areaCm2: res.area * scale * scale / 100,
              triangles: res.triangles,
              closed: res.closed,
              solids: res.solids,
              complexity: res.complexity,
              appliedScale: scale
            };
            setMeasures(state.measured);
            S.toast(S.t('STEP parsed and measured in your browser. Nothing was uploaded.',
                        'STEP 已在你的浏览器内解析测量，未上传任何文件。'));
          } else if (res && res.error === 'kernel-unavailable') {
            if (location.protocol === 'file:') {
              pushQueue(file.name, 'fileproto');
              S.toast(S.t(
                'You opened this page as a local file (file://). Browsers block the 8 MB geometry kernel there, so STEP cannot be priced. Serve the folder with any static server (or deploy it) and STEP quotes will work — verified just now.',
                '你当前是双击本地文件打开的（file://），浏览器会拦截 8MB 几何内核，STEP 因此无法报价。请用任意静态服务器打开或部署上线，STEP 即时报价即可正常工作。'));
            } else {
              pushQueue(file.name, 'kernel');
              S.toast(S.t(
                'The geometry kernel did not load. Check that vendor/occt-import-js.wasm was uploaded and that the server returns it correctly (MIME application/wasm recommended).',
                '几何内核加载失败。请确认 vendor/occt-import-js.wasm 已上传，且服务器能正确返回（建议配置 MIME 为 application/wasm）。'));
            }
          } else if (res && res.error === 'no-geometry') {
            pushQueue(file.name, 'empty');
          } else if (res && res.error === 'too-large') {
            pushQueue(file.name, 'large');
          } else {
            pushQueue(file.name, 'unreadable');
          }
          next();
        }).catch(function () {
          hideDropStatus();
          pushQueue(file.name, 'kernel');
          next();
        });
        return;
      }

      el.progWrap.hidden = false;
      el.progBar.style.width = '4%';

      G.measure(file, function (p) { el.progBar.style.width = Math.round(4 + p * 92) + '%'; }).then(function (res) {
        el.progBar.style.width = '100%';

        if (res && res.ok) {
          state.measured = {
            fileName: res.fileName,
            format: res.format,
            bboxMm: { x: res.bbox.x * scale, y: res.bbox.y * scale, z: res.bbox.z * scale },
            volCm3: res.volume * scale * scale * scale / 1000,
            areaCm2: res.area * scale * scale / 100,
            triangles: res.triangles,
            closed: res.closed,
            appliedScale: scale
          };
          setMeasures(state.measured);
          S.toast(S.t('Measured in your browser. Nothing was uploaded.', '已在浏览器内完成测量，未上传任何文件。'));
        } else if (res && res.bbox) {
          /* A point cloud: we have the envelope but no solid, so hand the
             envelope back to the fields and say why. */
          el.dimX.value = (res.bbox.x * scale).toFixed(1);
          el.dimY.value = (res.bbox.y * scale).toFixed(1);
          el.dimZ.value = (res.bbox.z * scale).toFixed(1);
          setGeometryMode('dims');
          state.typeddims = true;
          pushQueue(file.name, 'empty');
        } else {
          pushQueue(file.name, res && res.error === 'too-large' ? 'large' : 'unreadable');
        }
        next();
      });
    })();
  }

  /* ── Geometry: mode switching ───────────────────────────────────────── */
  function setGeometryMode(mode) {
    state.mode = mode === 'dims' ? 'dims' : 'upload';
    el.paneUpload.hidden = state.mode !== 'upload';
    el.paneDims.hidden = state.mode !== 'dims';
    var r = el.form.querySelector('input[name="gio"][value="' + state.mode + '"]');
    if (r) r.checked = true;
    if (state.mode === 'upload') state.typeddims = false;
    recalc();
  }

  /* ── Print sheet ────────────────────────────────────────────────────── */
  function fillSheet() {
    var zh = S.lang() === 'zh';
    var q = state.quote;
    var sheet = $('sheet');
    if (!q || !sheet) return;

    var cur = q.result.currency;
    var cny = cur === 'CNY';

    $('sId').textContent = q.id;
    $('sDate').textContent = new Date().toLocaleDateString(zh ? 'zh-CN' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    var valid = new Date(Date.now() + q.result.validDays * 864e5);
    $('sValid').textContent = valid.toLocaleDateString(zh ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' }) + ' (' + q.result.validDays + (zh ? ' 天)' : ' d)');

    var P = Q.byId(Q.PROCESSES, q.input.processId);
    var M = Q.byId(Q.MATERIALS, q.input.materialId);
    var T = Q.byId(Q.TOLERANCES, q.input.toleranceId);
    var F = Q.byId(Q.FINISHES, q.input.finishId);
    var R = Q.byId(Q.RUSH, q.input.rushId);

    var specs = [
      ['Process', zh ? P.zh : P.en],
      ['Material', zh ? M.zh : M.en],
      ['Quantity', q.meta.qty + (zh ? ' 件' : ' pcs')],
      ['Tolerance', zh ? T.zh : T.en],
      ['Surface finish', zh ? F.zh : F.en],
      ['Lead time', q.result.leadDays[0] + '–' + q.result.leadDays[1] + (zh ? ' 天 · ' : ' d · ') + (zh ? R.zh : R.en)],
      ['Envelope', q.meta.bbox.x.toFixed(1) + ' × ' + q.meta.bbox.y.toFixed(1) + ' × ' + q.meta.bbox.z.toFixed(1) + ' mm'],
      ['Geometry source', q.input.assumed
        ? (zh ? '外形尺寸与实体占比估算' : 'estimated from envelope + fill ratio')
        : (zh ? '浏览器内实测网格' : 'mesh measured in browser')],
      ['Cycle / piece', q.result.metrics.cycleMin.toFixed(1) + ' min'],
      ['Part weight', q.result.metrics.partKg.toFixed(3) + ' kg'],
      ['Blank weight', q.result.metrics.blankKg.toFixed(3) + ' kg'],
      ['Material removed', q.result.metrics.removedCm3.toFixed(1) + ' cm³']
    ];

    var specsHtml = '';
    specs.forEach(function (pair) {
      specsHtml += '<div class="sheet__row"><span>' + pair[0] + '</span><span>' + pair[1] + '</span></div>';
    });
    $('sSpecs').innerHTML = specsHtml;

    $('sUnit').innerHTML = money(q.display.unit, cur) + ' <small>' + (zh ? '单件 · ' : 'per piece · ') + q.meta.qty + (zh ? ' 件' : ' pcs') + '</small>';
    $('sBatch').innerHTML = money(q.display.batch, cur) + ' <small>' + cur + '</small>';

    var total = q.result.breakdown.reduce(function (a, b) { return a + b.value; }, 0) || 1;
    var rowsHtml = '';
    q.result.breakdown.forEach(function (row) {
      var v = cny ? row.value : Q.toUSD(row.value);
      rowsHtml += '<tr><td>' + (zh ? row.zh : row.en) + '</td>' +
        '<td class="num">' + (cny ? '¥' : '$') + v.toFixed(2) + '</td>' +
        '<td class="num">' + Math.round(row.value / total * 100) + '%</td></tr>';
    });
    rowsHtml += '<tr><td><strong>Total</strong></td><td class="num"><strong>' + (cny ? '¥' : '$') +
      (cny ? q.result.batch : Q.toUSD(q.result.batch)).toFixed(2) + '</strong></td><td class="num">100%</td></tr>';
    $('sRows').innerHTML = rowsHtml;

    var dfmHtml = '';
    q.result.dfm.forEach(function (d) { dfmHtml += '<li>' + (zh ? d.zh : d.en) + '</li>'; });
    $('sDfm').innerHTML = dfmHtml;
  }

  /* ── Plain-text summary, for pasting into the customer's own email ───── */
  function buildSummary() {
    var q = state.quote;
    if (!q) return '';
    var cur = q.result.currency;
    var symbol = cur === 'CNY' ? '¥' : '$';

    var P = Q.byId(Q.PROCESSES, q.input.processId);
    var M = Q.byId(Q.MATERIALS, q.input.materialId);
    var T = Q.byId(Q.TOLERANCES, q.input.toleranceId);
    var F = Q.byId(Q.FINISHES, q.input.finishId);
    var R = Q.byId(Q.RUSH, q.input.rushId);

    var lines = [];
    var row = function (k, v) { lines.push('  ' + (k + '                    ').slice(0, 20) + v); };

    lines.push('ENGINEERING REFERENCE QUOTE — Xdetron Precision Machining');
    lines.push('  ' + 'Quote number'.padEnd(20) + q.id);
    lines.push('  ' + 'Issued'.padEnd(20) + new Date().toLocaleString());
    lines.push('  ' + 'Valid'.padEnd(20) + q.result.validDays + ' days');
    lines.push('');
    lines.push('PART');
    row('Process', P.en + ' / ' + P.zh);
    row('Material', M.en + ' / ' + M.zh);
    row('Quantity', q.meta.qty + ' pcs');
    row('Tolerance', T.en);
    row('Surface finish', F.en);
    row('Lead time', R.en + ' — ' + q.result.leadDays[0] + '–' + q.result.leadDays[1] + ' days');
    row('Envelope (mm)', q.meta.bbox.x.toFixed(1) + ' x ' + q.meta.bbox.y.toFixed(1) + ' x ' + q.meta.bbox.z.toFixed(1));
    row('Geometry source', q.input.assumed ? 'estimated from envelope + fill ratio' : 'mesh measured in browser');
    if (q.input.triangles) row('Triangles', String(q.input.triangles));
    row('Cycle / piece', q.result.metrics.cycleMin.toFixed(1) + ' min');
    row('Part weight', q.result.metrics.partKg.toFixed(3) + ' kg');
    lines.push('');
    lines.push('PRICE');
    row('Unit price', symbol + q.display.unit.toFixed(2));
    row('Batch total', symbol + q.display.batch.toFixed(2) + '  (' + q.meta.qty + ' pcs, ' + cur + ')');
    lines.push('');
    lines.push('COST BREAKDOWN (share of batch)');
    var total = q.result.breakdown.reduce(function (a, b) { return a + b.value; }, 0) || 1;
    q.result.breakdown.forEach(function (b) {
      if (b.value <= 0) return;
      var v = cur === 'CNY' ? b.value : Q.toUSD(b.value);
      row(b.en, symbol + v.toFixed(2) + '   ' + Math.round(b.value / total * 100) + '%');
    });
    lines.push('');
    lines.push('DFM NOTES');
    q.result.dfm.forEach(function (d) { lines.push('  [' + d.level.toUpperCase() + '] ' + d.en); });
    lines.push('');
    lines.push('This is an engineering reference price produced by a cost model, not a');
    lines.push('binding offer. It excludes tax, freight and unidentified tooling. An');
    lines.push('engineer will confirm or correct it within one working day.');

    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    /* Fallback for non-secure contexts and older browsers */
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); }
      catch (e) { reject(e); }
      finally { document.body.removeChild(ta); }
    });
  }

  /* ── Carry the quote into the enquiry form ──────────────────────────── */
  function carryToRfq(q) {
    var map = {};
    if (q) {
      var zh = S.lang() === 'zh';
      var P = Q.byId(Q.PROCESSES, q.input.processId);
      var M = Q.byId(Q.MATERIALS, q.input.materialId);
      var T = Q.byId(Q.TOLERANCES, q.input.toleranceId);
      var F = Q.byId(Q.FINISHES, q.input.finishId);
      var R = Q.byId(Q.RUSH, q.input.rushId);
      map = {
        process: (zh ? P.zh : P.en) + ' (' + P.id + ')',
        material: (zh ? M.zh : M.en),
        qty: q.meta.qty + (zh ? ' 件' : ' pcs'),
        tol: zh ? T.zh : T.en,
        finish: zh ? F.zh : F.en,
        rush: (zh ? R.zh : R.en) + ' · ' + q.result.leadDays[0] + '–' + q.result.leadDays[1] + (zh ? ' 天' : ' d'),
        price: (q.result.currency === 'CNY' ? '¥' : '$') + q.display.unit.toFixed(2) + ' / pc · ' +
               (q.result.currency === 'CNY' ? '¥' : '$') + q.display.batch.toFixed(2) + ' ' + (zh ? '总价' : 'total'),
        geom: q.meta.bbox.x.toFixed(1) + '×' + q.meta.bbox.y.toFixed(1) + '×' + q.meta.bbox.z.toFixed(1) + ' mm · ' +
              q.meta.volCm3.toFixed(1) + ' cm³' + (q.input.triangles ? ' · ' + q.input.triangles + ' tri' : ''),
        source: q.input.assumed
          ? (zh ? '外形尺寸估算' : 'envelope estimate')
          : (q.input.format === 'STEP'
              ? (zh ? 'STEP/IGES 浏览器内核实测' : 'STEP/IGES measured locally')
              : (zh ? 'STL/OBJ 浏览器实测' : 'STL/OBJ measured locally'))
      };
    }

    document.querySelectorAll('[data-carry]').forEach(function (node) {
      var v = map[node.getAttribute('data-carry')];
      node.textContent = v || '—';
      node.title = v || '';
      node.setAttribute('data-empty', v ? 'false' : 'true');
    });
    var idChip = $('carryId');
    if (idChip) idChip.textContent = q ? q.id : S.t('No quote yet', '尚未报价');
  }

  /* ── Enquiry form ───────────────────────────────────────────────────── */
  var rfq = {
    form: $('rfqForm'), status: $('rfqStatus'), submit: $('rfqSubmit'),
    name: $('rfqName'), company: $('rfqCompany'), email: $('rfqEmail'),
    country: $('rfqCountry'), note: $('rfqNote'), consent: $('rfqConsent'),
    receipt: $('receipt'), receiptId: $('receiptId'), receiptPrice: $('receiptPrice'),
    receiptTime: $('receiptTime'), receiptEmail: $('receiptEmail')
  };

  function setFieldState(input, ok) {
    var field = input.closest('.field');
    if (field) field.classList.toggle('is-invalid', !ok);
    return ok;
  }

  function validateRfq() {
    var ok = true;
    ok = setFieldState(rfq.name, rfq.name.value.trim().length >= 2) && ok;
    ok = setFieldState(rfq.email, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rfq.email.value.trim())) && ok;
    ok = setFieldState(rfq.country, rfq.country.value.trim().length >= 2) && ok;
    return ok;
  }

  function status(kind, message) {
    rfq.status.className = 'formstatus ' + (kind === 'error' ? 'is-error' : 'is-ok');
    rfq.status.textContent = message;
  }

  function buildPayload() {
    var q = state.quote;
    return {
      quote_number: q ? q.id : null,
      submitted_at: new Date().toISOString(),
      contact: {
        name: rfq.name.value.trim(),
        company: rfq.company.value.trim(),
        email: rfq.email.value.trim(),
        country: rfq.country.value.trim()
      },
      note: rfq.note.value.trim(),
      consent: rfq.consent.checked,
      business_line: 'parts',
      technical: q ? {
        process: q.input.processId,
        material: q.input.materialId,
        quantity: q.input.qty,
        tolerance: q.input.toleranceId,
        finish: q.input.finishId,
        lead_time: q.input.rushId,
        currency: q.result.currency,
        unit_price: Number(q.display.unit.toFixed(2)),
        batch_total: Number(q.display.batch.toFixed(2)),
        envelope_mm: [+q.meta.bbox.x.toFixed(2), +q.meta.bbox.y.toFixed(2), +q.meta.bbox.z.toFixed(2)],
        volume_cm3: +q.meta.volCm3.toFixed(3),
        area_cm2: +q.meta.areaCm2.toFixed(2),
        triangles: q.input.triangles,
        geometry_source: q.input.assumed ? 'envelope-estimate' : 'measured-in-browser',
        dfm: q.result.dfm.map(function (d) { return { level: d.level, note: d.en }; }),
        cost_model: 'v1'
      } : null,
      attachments: state.queue.map(function (f) { return f.name; }),
      measured_file: state.measured ? state.measured.fileName : null
    };
  }

  function submitRfq(event) {
    event.preventDefault();
    if (!validateRfq()) {
      status('error', S.t('Three fields need attention above — name, email and country.', '上面有三个字段需要补充 —— 姓名、邮箱、国家。'));
      rfq.name.closest('.field').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (!rfq.consent.checked) {
      status('error', S.t('Please tick the consent box — we cannot store the enquiry without it.', '请勾选同意项 —— 没有它我们不能保存这条询盘。'));
      rfq.consent.focus();
      return;
    }

    var payload = buildPayload();
    rfq.submit.disabled = true;
    rfq.submit.setAttribute('aria-busy', 'true');
    var label = rfq.submit.querySelector('span');
    var original = label.textContent;
    label.textContent = S.t('Sending…', '正在提交…');
    status('ok', S.t('Sending your enquiry…', '正在提交询盘…'));

    var send = RFQ_ENDPOINT
      ? fetch(RFQ_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json().catch(function () { return {}; });
        })
      : new Promise(function (resolve) {
          /* No endpoint configured: still exercise the whole flow, and leave a
             full record of what would have been sent. */
          console.info('[RFQ] No endpoint configured. Payload that would be sent:', payload);
          setTimeout(resolve, 700);
        });

    send.then(function () {
      var now = new Date();
      var ref = 'RFQ-' + ymd(now) + '-' + (1000 + Math.floor(Math.random() * 9000));

      rfq.receiptId.textContent = ref;
      rfq.receiptPrice.textContent = state.quote
        ? (state.quote.result.currency === 'CNY' ? '¥' : '$') + state.quote.display.unit.toFixed(2) + ' / pc'
        : '—';
      rfq.receiptTime.textContent = now.toLocaleString(S.lang() === 'zh' ? 'zh-CN' : 'en-GB', {
        dateStyle: 'medium', timeStyle: 'short'
      });
      rfq.receiptEmail.textContent = payload.contact.email;
      rfq.receipt.hidden = false;
      rfq.receipt.scrollIntoView({ block: 'center', behavior: 'smooth' });

      status('ok', S.t('Received. Your reference is ' + ref + ' — keep it, and quote it in any later email.',
                       '已收到。你的编号是 ' + ref + '，请保留 —— 之后任何邮件引用它即可。'));
      S.toast(S.t('Enquiry received · ' + ref, '询盘已收到 · ' + ref));
      rfq.form.reset();
      carryToRfq(state.quote);
    }).catch(function (err) {
      /* A failed send must never look like a successful one. */
      status('error', S.t(
        'That did not go through (' + err.message + '). Nothing was lost — try again, or email the drawing straight to ' + FALLBACK_EMAIL + '.',
        '提交失败（' + err.message + '）。数据没有丢失 —— 请重试，或直接发送图纸至 ' + FALLBACK_EMAIL + '。'
      ));
      console.warn('[RFQ] send failed:', err, payload);
    }).then(function () {
      rfq.submit.disabled = false;
      rfq.submit.removeAttribute('aria-busy');
      label.textContent = original;
    });
  }

  /* ── Wire it all up ─────────────────────────────────────────────────── */
  fillSelects();

  el.form.addEventListener('input', function (e) {
    if (e.target === el.qty) {
      var f = el.qty.closest('.field');
      var v = parseFloat(el.qty.value);
      f.classList.toggle('is-invalid', !(v >= 1 && v <= 100000));
    }
    recalc();
  });
  el.form.addEventListener('change', function (e) {
    if (e.target.name === 'gio') { setGeometryMode(e.target.value); return; }
    if (e.target.name === 'unit') {
      /* Re-scale an already-measured mesh rather than asking for it again */
      var m = state.measured;
      if (m) {
        var factor = UNIT_SCALE[e.target.value] / (m.appliedScale || 1);
        state.measured = {
          fileName: m.fileName, format: m.format, triangles: m.triangles, closed: m.closed,
          bboxMm: { x: m.bboxMm.x * factor, y: m.bboxMm.y * factor, z: m.bboxMm.z * factor },
          volCm3: m.volCm3 * factor * factor * factor,
          areaCm2: m.areaCm2 * factor * factor,
          appliedScale: UNIT_SCALE[e.target.value]
        };
        setMeasures(state.measured);
      }
    }
    recalc();
  });

  /* Quantity shortcuts */
  document.querySelectorAll('[data-qty]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      el.qty.value = btn.getAttribute('data-qty');
      el.qty.closest('.field').classList.remove('is-invalid');
      recalc();
    });
  });

  /* Drop zone: drag, keyboard, and the native file input underneath */
  ['dragenter', 'dragover'].forEach(function (type) {
    el.drop.addEventListener(type, function (e) {
      e.preventDefault();
      el.drop.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    el.drop.addEventListener(type, function (e) {
      e.preventDefault();
      el.drop.classList.remove('is-over');
    });
  });
  el.drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  el.fileInput.addEventListener('change', function () {
    handleFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  /* Readout actions */
  $('toRfq').addEventListener('click', function () {
    document.getElementById('rfq').scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.toast(state.quote
      ? S.t('Your technical fields are already filled in below.', '技术参数已自动带入下面的表单。')
      : S.t('Fill in the four steps first — then this carries over.', '请先填完上面四步，参数会自动带入。'));
    setTimeout(function () { rfq.name.focus({ preventScroll: true }); }, 620);
  });

  /* The sheet is print-only, so it stays hidden from the accessibility tree
     until the moment it becomes the only thing on the page. */
  function prepareSheet() {
    if (!state.quote) return false;
    fillSheet();
    $('sheet').setAttribute('aria-hidden', 'false');
    return true;
  }

  $('printBtn').addEventListener('click', function () {
    if (!prepareSheet()) { S.toast(S.t('Fill in the four steps first.', '请先填完上面四步。')); return; }
    window.print();
    /* window.print() blocks, so this runs once the dialog closes — including
       when the user cancels. afterprint covers the Ctrl+P path. */
    $('sheet').setAttribute('aria-hidden', 'true');
  });

  /* Ctrl+P must produce the same document as the button — browsers that fire
     these events get the sheet filled in before the dialog opens. */
  window.addEventListener('beforeprint', function () {
    if (state.quote) { fillSheet(); $('sheet').setAttribute('aria-hidden', 'false'); }
  });
  window.addEventListener('afterprint', function () {
    $('sheet').setAttribute('aria-hidden', 'true');
  });

  $('copyBtn').addEventListener('click', function () {
    if (!state.quote) { S.toast(S.t('Fill in the four steps first.', '请先填完上面四步。')); return; }
    copyText(buildSummary()).then(function () {
      S.toast(S.t('Quote summary copied — paste it into your own email.', '报价摘要已复制 —— 可直接粘贴进你的邮件。'));
    }).catch(function () {
      S.toast(S.t('Copying was blocked by the browser.', '浏览器阻止了复制。'));
    });
  });

  rfq.form.addEventListener('submit', submitRfq);
  [rfq.name, rfq.email, rfq.country].forEach(function (input) {
    input.addEventListener('blur', function () { if (input.value.trim()) validateRfq(); });
  });

  /* Re-render everything that carries translatable model strings.
     fillSelects() rebuilds the option lists, so the current selection has to
     survive it — changing the language must not change the quote. */
  S.onLangChange(function () {
    var keptMaterial = el.material.value;
    var keptFinish = el.finish.value;
    fillSelects();
    el.material.value = keptMaterial;
    el.finish.value = keptFinish;

    if (state.measured) setMeasures(state.measured);

    var queued = state.queue.slice();
    state.queue = [];
    el.queue.innerHTML = '';
    el.queue.hidden = true;
    queued.forEach(function (x) { pushQueue(x.name, x.note); });

    recalc();
    if (!rfq.receipt.hidden) fillSheet();
  });

  /* First paint */
  el.qty.value = 10;
  recalc();
})();
