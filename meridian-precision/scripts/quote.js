/* ═══════════════════════════════════════════════════════════════
   quote.js — machining cost model
   A transparent, editable cost model: blank volume → material cost,
   removal volume ÷ removal rate → cutting time, machine hour rate,
   set-up amortised across the batch, finishing priced by area,
   inspection priced by tolerance class.

   ⚠ ALL RATES BELOW ARE PLACEHOLDERS.
     Replace them with your own 2026 purchasing prices, machine hour
     rates and inspection costs before you publish a number to a
     customer. The model is honest; the inputs must be yours.

   Public API: window.QuoteEngine
   ═══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── Global commercial constants ── */
  var FX = 7.15;          // RMB per USD — update with your bank rate
  var OVERHEAD = 0.12;    // 管理 / 能耗 / 刀具损耗摊销
  var MARGIN = 0.28;      // 毛利
  var WASTE = 0.08;       // 材料损耗（切头、夹头余量）
  var VALID_DAYS = 14;    // 报价有效期

  /* ── Processes ──
     rate      机时费率 RMB/h
     setupMin  单批开机（装夹 + 对刀 + 首件调试）分钟
     program   编程/CAM 一次性费用 RMB
     mrrFactor 相对材料基准去除率的系数
     handling  上下料与辅助时间，分钟/件
     allowance 毛坯余量系数（体积）
  */
  var PROCESSES = [
    { id: 'cnc3',   en: '3-axis milling',      zh: '三轴铣削',   rate: 105, setupMin: 35, program: 45,  mrrFactor: 1.00, handling: 2.2, allowance: 1.18 },
    { id: 'turn',   en: 'CNC turning',         zh: 'CNC 车削',   rate: 85,  setupMin: 25, program: 35,  mrrFactor: 1.15, handling: 1.6, allowance: 1.12 },
    { id: 'tm',     en: 'Turn-mill',           zh: '车铣复合',   rate: 165, setupMin: 45, program: 70,  mrrFactor: 1.05, handling: 2.4, allowance: 1.15 },
    { id: 'cnc5',   en: '5-axis simultaneous', zh: '五轴联动',   rate: 215, setupMin: 60, program: 120, mrrFactor: 0.95, handling: 2.8, allowance: 1.15 },
    { id: 'laser',  en: 'Laser cutting',       zh: '激光切割',   rate: 70,  setupMin: 15, program: 30,  mrrFactor: 1.60, handling: 1.2, allowance: 1.03 },
    { id: 'bend',   en: 'Sheet bending',       zh: '钣金折弯',   rate: 65,  setupMin: 20, program: 25,  mrrFactor: 0.90, handling: 1.5, allowance: 1.02 },
    { id: 'wire',   en: 'Wire EDM',            zh: '线切割',     rate: 120, setupMin: 40, program: 55,  mrrFactor: 0.35, handling: 2.0, allowance: 1.05 },
    { id: 'sinker', en: 'Sinker EDM',          zh: '电火花',     rate: 165, setupMin: 60, program: 90,  mrrFactor: 0.25, handling: 2.5, allowance: 1.05 }
  ];

  /* ── Materials ──
     density    g/cm³
     pricePerKg RMB/kg（材料采购价）
     mrrBase    基准材料去除率 cm³/min（铝 6061 为 14）
     toolWear   刀具磨损系数（钛/不锈钢显著更高）
  */
  var MATERIALS = [
    { id: 'al6061',  group: 'aluminium', en: 'Aluminium 6061-T6',  zh: '铝合金 6061-T6',  density: 2.70, pricePerKg: 26,  mrrBase: 14.0, toolWear: 1.00, tensile: '310 MPa' },
    { id: 'al7075',  group: 'aluminium', en: 'Aluminium 7075-T6',  zh: '铝合金 7075-T6',  density: 2.81, pricePerKg: 44,  mrrBase: 11.0, toolWear: 1.15, tensile: '572 MPa' },
    { id: 'sus304',  group: 'stainless', en: 'Stainless 304',      zh: '不锈钢 304',      density: 7.93, pricePerKg: 24,  mrrBase: 4.6,  toolWear: 2.10, tensile: '520 MPa' },
    { id: 'sus316l', group: 'stainless', en: 'Stainless 316L',     zh: '不锈钢 316L',     density: 8.00, pricePerKg: 33,  mrrBase: 3.9,  toolWear: 2.30, tensile: '485 MPa' },
    { id: 'steel1045', group: 'steel',   en: 'Carbon steel 1045',  zh: '碳钢 45#',        density: 7.85, pricePerKg: 7.0, mrrBase: 5.6,  toolWear: 1.60, tensile: '600 MPa' },
    { id: 'brass',   group: 'copper',    en: 'Brass H62',          zh: '黄铜 H62',        density: 8.50, pricePerKg: 56,  mrrBase: 10.0, toolWear: 1.05, tensile: '370 MPa' },
    { id: 'ti64',    group: 'titanium',  en: 'Titanium Ti-6Al-4V', zh: '钛合金 TC4',      density: 4.43, pricePerKg: 320, mrrBase: 1.7,  toolWear: 4.20, tensile: '950 MPa' },
    { id: 'pom',     group: 'plastic',   en: 'POM',                zh: '聚甲醛 POM',      density: 1.41, pricePerKg: 34,  mrrBase: 26.0, toolWear: 0.90, tensile: '—' },
    { id: 'peek',    group: 'plastic',   en: 'PEEK',               zh: '聚醚醚酮 PEEK',   density: 1.32, pricePerKg: 620, mrrBase: 17.0, toolWear: 1.35, tensile: '—' },
    { id: 'abs',     group: 'plastic',   en: 'ABS',                zh: 'ABS 工程塑料',    density: 1.04, pricePerKg: 22,  mrrBase: 30.0, toolWear: 0.85, tensile: '—' }
  ];

  var MATERIAL_GROUPS = [
    { id: 'aluminium', en: 'Aluminium',   zh: '铝合金' },
    { id: 'stainless', en: 'Stainless',   zh: '不锈钢' },
    { id: 'steel',     en: 'Steel',       zh: '碳钢 / 合金钢' },
    { id: 'copper',    en: 'Copper alloy', zh: '铜合金' },
    { id: 'titanium',  en: 'Titanium',    zh: '钛合金' },
    { id: 'plastic',   en: 'Engineering plastics', zh: '工程塑料' }
  ];

  /* ── Surface finishing: priced by part surface area ── */
  var FINISHES = [
    { id: 'none',        en: 'As machined',        zh: '原色（不处理）', perCm2: 0,    minCharge: 0 },
    { id: 'anodize',     en: 'Anodise Type II',    zh: '阳极氧化',       perCm2: 0.06, minCharge: 45 },
    { id: 'beadAnodize', en: 'Bead blast + anodise', zh: '喷砂 + 阳极氧化', perCm2: 0.09, minCharge: 62 },
    { id: 'zinc',        en: 'Zinc plating',       zh: '电镀锌',         perCm2: 0.05, minCharge: 50 },
    { id: 'powder',      en: 'Powder coating',     zh: '静电喷粉',       perCm2: 0.08, minCharge: 55 },
    { id: 'blackOxide',  en: 'Black oxide',        zh: '发黑处理',       perCm2: 0.04, minCharge: 40 },
    { id: 'polish',      en: 'Mirror polish',      zh: '镜面抛光',       perCm2: 0.12, minCharge: 72 }
  ];

  /* ── Tolerance classes ──
     factor   对机加工成本的整体系数（精修走刀、更多测量）
     qcPerPc  单件检测成本 RMB
     pass     走刀次数系数
  */
  var TOLERANCES = [
    { id: 'general',   en: 'General ±0.10',  zh: '一般 ±0.10',  mm: '±0.10', factor: 1.00, qcPerPc: 0.6, pass: 1.00 },
    { id: 'precision', en: 'Precision ±0.02', zh: '精密 ±0.02', mm: '±0.02', factor: 1.16, qcPerPc: 1.8, pass: 1.12 },
    { id: 'high',      en: 'High ±0.005',    zh: '高精密 ±0.005', mm: '±0.005', factor: 1.42, qcPerPc: 4.5, pass: 1.30 }
  ];

  /* ── Lead time ── */
  var RUSH = [
    { id: 'standard', en: 'Standard',    zh: '标准',    factor: 1.00, days: [8, 12] },
    { id: 'rush',     en: 'Fast track',  zh: '加急',    factor: 1.28, days: [4, 6] },
    { id: 'express',  en: 'Express 48 h', zh: '特急 48h', factor: 1.62, days: [2, 3] }
  ];

  /* ── Lookups ── */
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ── The model ──
     input: {
       volumeCm3, areaCm2, bbox {x,y,z} in mm,
       processId, materialId, toleranceId, finishId, rushId, qty,
       assumed (bool), closed (bool|null), triangles (int), currency
     }
  */
  function compute(input) {
    var P = byId(PROCESSES, input.processId);
    var M = byId(MATERIALS, input.materialId);
    var T = byId(TOLERANCES, input.toleranceId);
    var F = byId(FINISHES, input.finishId);
    var R = byId(RUSH, input.rushId);

    var qty = clamp(Math.round(input.qty || 1), 1, 100000);
    var partVol = Math.max(input.volumeCm3 || 0, 0.002);
    var area = Math.max(input.areaCm2 || 0, 0.5);
    var bb = input.bbox || { x: 50, y: 50, z: 20 };

    /* 1. Stock: envelope plus machining allowance, never smaller than the part */
    var bboxVol = Math.max((bb.x * bb.y * bb.z) / 1000, partVol);
    var blankVol = Math.max(bboxVol * P.allowance, partVol * 1.03);

    /* 2. Removal: how much metal has to become chips */
    var removed = clamp(blankVol - partVol, blankVol * 0.15, blankVol * 0.94);

    /* 3. Cutting time = removal ÷ removal rate; rate depends on material and process */
    var mrr = M.mrrBase * P.mrrFactor;
    var cutMin = removed / mrr;

    /* 4. Auxiliary time grows with part size and feature count */
    var sizeFactor = 1 + Math.min(blankVol / 900, 1.4);
    var complexFactor = input.triangles && input.triangles > 120000 ? 1.18 : 1;
    var runMin = cutMin * T.pass + P.handling * sizeFactor * complexFactor;

    /* 5. Per-part costs */
    var materialUnit = blankVol * M.density / 1000 * M.pricePerKg * (1 + WASTE);
    var machineUnit = runMin / 60 * P.rate * T.factor;
    var toolUnit = machineUnit * M.toolWear * 0.10;
    var qcUnit = T.qcPerPc + (area > 900 ? 2.2 : 0);

    /* 6. Learning curve: every doubling of quantity takes ~7% off the variable cost */
    var learning = qty > 1 ? Math.pow(qty, Math.log(0.93) / Math.log(2)) : 1;
    var variableUnit = (materialUnit + machineUnit + toolUnit + qcUnit) * learning;

    /* 7. One-off work, amortised across the batch — this is what makes qty 1 expensive */
    var setupTotal = (P.setupMin / 60) * P.rate + P.program;

    /* 8. Finishing is quoted on surface area, with a per-batch minimum */
    var finishTotal = F.perCm2 > 0
      ? Math.max(area * qty * F.perCm2, F.minCharge)
      : 0;

    /* 9. Lead-time premium applies to machine time and set-up, not to material */
    var rushPremium = ((machineUnit * learning * qty) + setupTotal) * (R.factor - 1);

    var matTotal = materialUnit * qty;
    var machTotal = machineUnit * learning * qty + toolUnit * learning * qty + setupTotal + rushPremium;
    var qcTotal = qcUnit * learning * qty;
    var base = matTotal + machTotal + finishTotal + qcTotal;
    var price = base * (1 + OVERHEAD) * (1 + MARGIN);
    var ohTotal = price - base;

    var unit = price / qty;

    /* DFM — rule-based, bilingual, honest about what is assumed */
    var dfm = [];
    var bb_min = Math.min(bb.x, bb.y, bb.z);
    var bb_max = Math.max(bb.x, bb.y, bb.z);
    var diag = Math.sqrt(bb.x * bb.x + bb.y * bb.y + bb.z * bb.z);
    var solidity = partVol / Math.max(bboxVol, 1e-6);

    if (input.assumed) {
      dfm.push({
        level: 'warn',
        en: 'Solid volume was estimated from your envelope and fill ratio, not measured. Expect the price to move once we see the model.',
        zh: '实体体积由外形尺寸与实体占比估算，并非实测。看到模型后价格会调整。'
      });
    }
    if (input.closed === false) {
      dfm.push({
        level: 'warn',
        en: 'This mesh is not watertight, so the computed volume is approximate. A STEP file gives us an exact number.',
        zh: '这个网格不是封闭体，算出的体积是近似值。给一份 STEP 我们能拿到精确数值。'
      });
    }
    if (bb_min < 3) {
      dfm.push({
        level: 'high',
        en: 'Smallest dimension is under 3 mm. Thin sections deflect and need support or light finishing passes.',
        zh: '最小方向尺寸不足 3 mm。薄壁会变形，需要支撑或轻切削走刀。'
      });
    }
    if (bb_max / bb_min > 8) {
      dfm.push({
        level: 'warn',
        en: 'Long and slender (aspect ratio over 8:1). Expect a steady rest or a split set-up — both add cost.',
        zh: '细长件（长径比超过 8:1）。需要跟刀架或分段装夹，两者都会推高成本。'
      });
    }
    if (diag > 800) {
      dfm.push({
        level: 'high',
        en: 'Diagonal over 800 mm. Confirm your machine envelope covers it, or we quote a sub-assembly instead.',
        zh: '对角线超过 800 mm。请确认你的机床行程，或者改报分体结构。'
      });
    }
    if (solidity < 0.12 && bb_min > 5) {
      dfm.push({
        level: 'warn',
        en: 'Only ' + Math.round(solidity * 100) + '% of the envelope is solid. Large removal volume — a casting or a welded assembly is usually cheaper at this quantity.',
        zh: '外形内实体占比仅 ' + Math.round(solidity * 100) + '%，去除量大。这个数量下，铸件或焊接件通常更便宜。'
      });
    }
    if (area / partVol > 6) {
      dfm.push({
        level: 'warn',
        en: 'High surface-area-to-volume ratio: many faces, long tool paths, and finishing is priced per area.',
        zh: '表面积与体积比偏高：面数多、刀路长，而表面处理是按面积计费的。'
      });
    }
    if ((M.id === 'ti64' || M.id === 'sus304' || M.id === 'sus316l') && T.id === 'high') {
      dfm.push({
        level: 'warn',
        en: 'High tolerance on ' + M.en + ' is expensive work. Relax the tolerances that are not functional — it is often the single biggest saving on the drawing.',
        zh: '在' + M.zh + '上做高精密公差是硬活。把非功能性公差放宽，通常是图纸上最省钱的一处改动。'
      });
    }
    if (M.id === 'ti64' || M.id === 'peek') {
      dfm.push({
        level: 'warn',
        en: 'Material dominates this price. Check the blank size — trimming the envelope a few millimetres can beat any cycle-time saving.',
        zh: '材料成本占大头。核对毛坯尺寸 —— 外形缩几毫米，比省加工时间更有效。'
      });
    }
    if ((P.id === 'laser' || P.id === 'bend') && T.id !== 'general') {
      dfm.push({
        level: 'warn',
        en: 'Laser cutting and bending do not hold ±0.02 routinely. If it is a sheet part, quote it as general tolerance.',
        zh: '激光切割与折弯做不到稳定的 ±0.02。如果是钣金件，按一般公差报。'
      });
    }
    if (P.id === 'laser' || P.id === 'bend') {
      dfm.push({
        level: 'ok',
        en: 'Sheet parts are priced by cut length and bend count in production; this envelope estimate is a ceiling, not a floor.',
        zh: '量产时钣金件按切割米数与折弯次数计价，这里的包络估算是上限，不是下限。'
      });
    }
    if (input.triangles > 300000) {
      dfm.push({
        level: 'warn',
        en: 'Very dense mesh (' + input.triangles.toLocaleString() + ' triangles) — usually sculpted surfaces, which means long finishing passes.',
        zh: '网格很密（' + input.triangles.toLocaleString() + ' 个三角面），通常是雕塑曲面，意味着很长的精加工走刀。'
      });
    }
    if (T.id === 'high' && bb_max < 40) {
      dfm.push({
        level: 'ok',
        en: 'Small part at high tolerance: we would run it on the 5-axis and inspect on the CMM. Achievable.',
        zh: '小件高精度：我们会放在五轴上做，用三次元检测。可以做。'
      });
    }
    if (!dfm.some(function (d) { return d.level !== 'ok'; })) {
      dfm.push({
        level: 'ok',
        en: 'Geometry is unremarkable for this process. Nothing here needs a second set-up or a custom cutter.',
        zh: '这个工艺下几何很常规。不需要二次装夹，也不需要定制刀具。'
      });
    }
    dfm.push({
      level: 'ok',
      en: 'Any geometry is indicative until an engineer has read the drawing — send it and we will confirm or correct this price.',
      zh: '在工程师读图之前，所有几何信息都只是参考 —— 把图发来，我们会确认或修正这个价格。'
    });

    return {
      currency: input.currency === 'USD' ? 'USD' : 'CNY',
      unit: unit,
      batch: price,
      qty: qty,
      validDays: VALID_DAYS,
      leadDays: R.days,
      breakdown: [
        { key: 'material', en: 'Material', zh: '材料', value: matTotal },
        { key: 'machining', en: 'Machining, set-up & tooling', zh: '加工、开机与刀具', value: machTotal },
        { key: 'finishing', en: 'Surface finishing', zh: '表面处理', value: finishTotal },
        { key: 'inspection', en: 'Inspection', zh: '检测', value: qcTotal },
        { key: 'overhead', en: 'Overhead & margin', zh: '管理与利润', value: ohTotal }
      ],
      metrics: {
        cycleMin: runMin,
        partKg: partVol * M.density / 1000,
        blankKg: blankVol * M.density / 1000,
        removedCm3: removed,
        mrrActual: removed / Math.max(runMin, 0.1),
        blankVol: blankVol,
        solidity: solidity,
        learning: learning,
        mrr: mrr
      },
      dfm: dfm,
      constants: { FX: FX, OVERHEAD: OVERHEAD, MARGIN: MARGIN, WASTE: WASTE }
    };
  }

  /* ── Currency formatting ── */
  function formatMoney(value, currency, decimals) {
    var d = decimals === undefined ? (value >= 100 ? 2 : 2) : decimals;
    var symbol = currency === 'USD' ? '$' : '¥';
    var text = value.toLocaleString(currency === 'USD' ? 'en-US' : 'zh-CN', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
    return { symbol: symbol, text: text };
  }

  global.QuoteEngine = {
    FX: FX,
    VALID_DAYS: VALID_DAYS,
    PROCESSES: PROCESSES,
    MATERIALS: MATERIALS,
    MATERIAL_GROUPS: MATERIAL_GROUPS,
    FINISHES: FINISHES,
    TOLERANCES: TOLERANCES,
    RUSH: RUSH,
    byId: byId,
    compute: compute,
    formatMoney: formatMoney,
    toUSD: function (cny) { return cny / FX; },
    toCNY: function (usd) { return usd * FX; }
  };
})(window);
