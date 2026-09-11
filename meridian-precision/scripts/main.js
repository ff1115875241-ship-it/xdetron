/* ═══════════════════════════════════════════════════════════════════════════
   main.js — interface behaviour
   ───────────────────────────────────────────────────────────────────────────
   Theme, language, the scroll choreography, the hero entrance, count-ups.
   No dependencies. Everything here degrades: with JavaScript disabled the
   page still reads correctly, because every animated element ships with its
   final value in the markup.

   Public helpers used by quote-flow.js:
     window.Site.lang()            'en' | 'zh'
     window.Site.t(en, zh)         pick a string for the current language
     window.Site.toast(text)       transient confirmation
     window.Site.onLangChange(fn)
   ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var STORE = { theme: 'mp.theme', lang: 'mp.lang' };

  /* Respect the operating system unless the visitor has chosen explicitly.
     localStorage can throw in private modes — hence the try/catch. */
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }

  var prefersReduce = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  /* ── Language ────────────────────────────────────────────────────────── */
  var langListeners = [];
  var lang = read(STORE.lang) || (String(navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en');

  /* The two documents that are not the home page carry their own titles. */
  var TITLES = {
    'index': {
      en: 'Xdetron Precision Machining — Instant CNC Machining Quote',
      zh: '艾得创精密加工 · 在线 CNC 报价'
    },
    'equipment': {
      en: 'Non-standard equipment — from requirement to FAT',
      zh: '非标设备定制 —— 从需求到验收'
    },
    'privacy': {
      en: 'Privacy, cookies and terms',
      zh: '隐私、Cookie 与条款'
    }
  };

  function t(en, zh) { return lang === 'zh' ? zh : en; }

  function applyLang(next, announce) {
    lang = next === 'zh' ? 'zh' : 'en';
    root.setAttribute('lang', lang);

    /* Text content and placeholders, in pairs */
    doc.querySelectorAll('[data-en]').forEach(function (el) {
      var v = el.getAttribute('data-' + lang);
      if (v !== null) el.textContent = v;
    });
    doc.querySelectorAll('[data-en-ph]').forEach(function (el) {
      var v = el.getAttribute('data-' + lang + '-ph');
      if (v !== null) el.setAttribute('placeholder', v);
    });
    doc.querySelectorAll('[data-en-aria]').forEach(function (el) {
      var v = el.getAttribute('data-' + lang + '-aria');
      if (v !== null) el.setAttribute('aria-label', v);
    });

    doc.querySelectorAll('.seg-mini [data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });

    /* Page title, if we know this page */
    var key = (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
    if (TITLES[key]) doc.title = TITLES[key][lang];

    write(STORE.lang, lang);
    if (announce !== false) {
      langListeners.forEach(function (fn) {
        try { fn(lang); } catch (e) { /* one bad listener must not stop the rest */ }
      });
    }
  }

  doc.querySelectorAll('.seg-mini [data-lang]').forEach(function (btn) {
    btn.addEventListener('click', function () { applyLang(btn.getAttribute('data-lang')); });
  });

  /* ── Theme ───────────────────────────────────────────────────────────── */
  var theme = read(STORE.theme);
  if (!theme) {
    theme = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', theme);

  var themeBtn = doc.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed', String(theme === 'dark'));
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      themeBtn.setAttribute('aria-pressed', String(next === 'dark'));
      write(STORE.theme, next);
    });
  }

  /* ── Toast ───────────────────────────────────────────────────────────── */
  var toastEl = doc.getElementById('toast');
  var toastTimer = null;
  function toast(text, ms) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, ms || 2600);
  }

  /* ── Count-up ────────────────────────────────────────────────────────── */
  function format(value, decimals) {
    return value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function countUp(el) {
    if (el.dataset.counted === '1') return;
    el.dataset.counted = '1';
    var to = parseFloat(el.getAttribute('data-to'));
    var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
    if (isNaN(to)) return;
    if (prefersReduce.matches) { el.textContent = format(to, dec); return; }

    var start = performance.now();
    var dur = 1150;
    (function step(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);          /* easeOutCubic */
      el.textContent = format(to * eased, dec);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = format(to, dec);
    })(start);
  }

  /* ── Scroll reveals ──────────────────────────────────────────────────── */
  if ('IntersectionObserver' in global) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.add('is-in');
        el.querySelectorAll('.count').forEach(countUp);
        if (el.classList.contains('count')) countUp(el);
        revealObserver.unobserve(el);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

    doc.querySelectorAll('.reveal, .step').forEach(function (el) { revealObserver.observe(el); });
  } else {
    /* No observer support: show everything, count immediately. */
    doc.querySelectorAll('.reveal, .step').forEach(function (el) { el.classList.add('is-in'); });
    doc.querySelectorAll('.count').forEach(countUp);
  }

  /* ── Hero entrance ───────────────────────────────────────────────────── */
  /* The drawing starts once the page has settled, so the strokes land after
     the headline rather than fighting it. */
  var specimen = doc.getElementById('specimen');
  if (specimen) {
    var arm = function () {
      setTimeout(function () { specimen.classList.add('is-ready'); }, prefersReduce.matches ? 0 : 260);
    };
    if (doc.readyState === 'complete') arm();
    else global.addEventListener('load', arm);
  }

  /* ── Nav state, section rail, scroll spy ─────────────────────────────── */
  var nav = doc.getElementById('nav');
  var subnav = doc.getElementById('subnav');
  var hero = doc.querySelector('.hero');
  var sections = Array.prototype.slice.call(doc.querySelectorAll('main section[id]'));
  var spyLinks = Array.prototype.slice.call(doc.querySelectorAll('.nav__link[href^="#"], .subnav__link[href^="#"]'));

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = global.scrollY || global.pageYOffset;
      if (nav) nav.classList.toggle('is-stuck', y > 8);

      if (subnav) {
        var trigger = hero ? hero.offsetHeight - 120 : 400;
        subnav.classList.toggle('is-visible', y > trigger);
      }

      /* Which section are we inside? */
      var current = null;
      var probe = y + (global.innerHeight || 800) * 0.32;
      sections.forEach(function (s) {
        if (s.offsetTop <= probe) current = s.id;
      });
      spyLinks.forEach(function (a) {
        var match = a.getAttribute('href') === '#' + current;
        if (match) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });

      ticking = false;
    });
  }
  global.addEventListener('scroll', onScroll, { passive: true });
  global.addEventListener('resize', onScroll, { passive: true });
  onScroll();

  /* ── Publish the small helper surface ────────────────────────────────── */
  global.Site = {
    lang: function () { return lang; },
    t: t,
    toast: toast,
    format: format,
    reducedMotion: function () { return prefersReduce.matches; },
    onLangChange: function (fn) { langListeners.push(fn); }
  };

  /* Apply the stored language without re-announcing on first paint. */
  applyLang(lang, false);
})(window);
