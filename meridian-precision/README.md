# Xdetron Precision Machining — CNC quoting site

A bilingual (EN / 简体中文), zero-dependency marketing and quoting site for an
export-oriented CNC machining shop: instant reference pricing for machined
parts, and a separate, properly-scoped line for non-standard equipment.

**Open `index.html` in a browser. There is no build step.**

---

## 1 · Design direction

**"Calm Precision."** The spatial generosity, type discipline and scroll
choreography of a premium consumer product page, applied to industrial
metrology instead of phones.

| | Decision | Why |
|---|---|---|
| Display face | **Schibsted Grotesk** 700–800, tracking −0.042em | A neo-grotesque that sits next to SF Pro in spirit without being it, and is not on the generic-AI-output list |
| Body face | **Manrope** 400–600 | Slightly geometric, holds up at 13–17 px |
| Data face | **IBM Plex Mono** 400–600, `tabular-nums` | Every dimension, price and part code is monospaced so columns of numbers align |
| Chinese | System PingFang SC / Microsoft YaHei / Noto Sans SC | Zero download; CJK webfonts cost 2–6 MB for no benefit |
| Colour | Near-white `#F4F5F7` page · near-black `#0E1116` ink · **one** accent `#0A56F0` | 17.3:1 and 5.8:1 on the two surfaces that matter |
| Dark mode | `#08090B` page, accent lifts to `#3D7DFF` | Button text flips to near-black, because white on a light blue fails contrast |
| Memory hook | The hero **engineering drawing that draws itself**, and the dark machining console | The price is a reading on a machine, not a number on a webpage |

### On the Apple reference, and on infringement

The brief was "Apple-like, but absolutely no copying." Here is the line that
was actually drawn:

**Taken (not protectable):** spatial rhythm, a large type scale with tight
tracking, generous negative space, a translucent sticky navigation bar,
full-bleed dark sections, large-radius cards, one orchestrated page-load
sequence, a floating section rail, pill-shaped buttons.

**Refused (protectable or identifying):** the Apple logo and the Apple wordmark;
the SF Pro / SF Compact font files; Apple's product photography; Apple's copy
and page structure; Apple's specific colour values; any reference to Apple or
its products anywhere in the content. The brand, the drawing, the copy, the
code, the cost model and every SVG on the site are original.

Fonts are SIL OFL — free for commercial use, no attribution required. **The
site contains zero images**: no stock photography, no competitor screenshots,
no customer logos. Every graphic is CSS or hand-written SVG, so there is no
image-licensing exposure at all.

Colours themselves are not copyrightable in any jurisdiction we sell into, but
they were still re-picked rather than sampled.

---

## 2 · Files

```
meridian-precision/
├── index.html            parts line: hero, quote console, capabilities,
│                         materials, process, quality, equipment teaser, FAQ,
│                         enquiry form, A4 print sheet
├── equipment.html        non-standard equipment line (no instant pricing, by design)
├── privacy.html          privacy notice · price disclaimer · standard terms
├── robots.txt
├── sitemap.xml
├── styles/
│   ├── tokens.css        every colour, size, space, radius, shadow, duration
│   ├── base.css          reset, type scale, focus, motion primitives
│   └── components.css    every component, plus the dark scope
├── vendor/
│   ├── occt-import-js.js       OpenCascade WASM loader (lazy-loaded, LGPL-2.1)
│   └── occt-import-js.wasm     the kernel itself, ~7.6 MB — required for STEP/IGES
└── scripts/
    ├── stl.js            STL (binary + ASCII) and OBJ parser. Nothing uploads.
    ├── occt.js           STEP/IGES bridge: tessellates via the kernel in-browser
    ├── quote.js          the cost model + rate tables  ← THIS IS YOUR MOAT
    ├── main.js           theme, language, scroll choreography
    └── quote-flow.js     console wiring, quote numbers, print, copy, enquiry
```

`.shots/` holds the rendered screenshots used for visual QA. Delete it before
you deploy.

---

## 3 · Run it

```bash
cd meridian-precision
python -m http.server 8080
# → http://localhost:8080
```

Opening `index.html` straight from disk also works. Google Fonts is the only
external request; without network access the site falls back to Helvetica/Arial
and still reads correctly.

---

## 4 · The quote engine

Drop an **STL or OBJ** and it is parsed in the browser: bounding box, volume by
signed tetrahedra, surface area, triangle count, and a watertight check by edge
pairing below 60 000 triangles. Large meshes are chunked so the tab stays
responsive. **The file never leaves the page.**

Drop a **STEP, STP, IGES or BREP** and the page lazy-loads an OpenCascade
geometry kernel compiled to WebAssembly (`vendor/occt-import-js`, ~7.6 MB,
fetched once and cached), tessellates the B-rep model into a mesh **in the
browser**, and feeds the same measuring pipeline — so STEP parts get an instant
reference price too. File units are normalised to millimetres by the kernel.
Curved-surface-heavy models (triangles-per-diagonal heuristic) still get a
price plus an honest DFM note recommending engineer confirmation. If the
kernel fails to load, the file falls back to the engineer queue automatically.

**DWG / DXF / PDF / native CAD** (SLDPRT, IPT) cannot be measured in a browser,
so the engine does not pretend: they go to an engineer's queue, announced by a
toast and an inline note under the upload area.

No 3D file? Envelope + solid fill ratio prices it too, and the quote says on
its face that the geometry was estimated.

### What the price is made of

| Step | Rule |
|---|---|
| Stock | envelope × process allowance, never smaller than the part |
| Material | stock volume × density × price/kg × (1 + 8 % waste) |
| Cutting time | removed volume ÷ (material removal rate × process factor) |
| Machine cost | run time × machine-hour rate, plus tool-wear and handling |
| Set-up | one-off, **amortised across the batch** — this is why qty 1 is expensive |
| Learning curve | every doubling of quantity takes ~7 % off variable cost |
| Finishing | priced per cm² of surface, with a per-batch minimum |
| Rush premium | applied to machine time and set-up, **never to material** |

Output: unit price, batch total, lead time, cycle per piece, part and blank
weight, material removed, a five-way cost breakdown, and rule-based DFM notes
(thin walls, slenderness over 8:1, low solidity suggesting a casting, titanium
at high tolerance, sheet metal that cannot hold ±0.02…).

### ⚠ Calibrate the rate tables before you publish a single number

`scripts/quote.js` contains three tables — `PROCESSES`, `MATERIALS`,
`FINISHES` — plus `FX`, `OVERHEAD`, `MARGIN`, `WASTE`. **They are plausible
placeholders, not your costs.** The model is honest; the inputs are what make
it yours, and they are the one thing a competitor cannot copy from your page
source. Sit with your 2026 purchasing prices and rewrite all four constants
before this site sees a customer.

Every generated quote carries a number in the form `QT-260910-5969`. The same
configuration always produces the same number (it is a hash of the inputs, not
a counter), so a customer can quote it back to you and you find the same quote.

**Printing.** The A4 sheet is kept in step with the screen automatically —
recalculating the quote re-fills it, so both the Print button and plain
`Ctrl+P` / `⌘P` produce the same one-page document (verified in Chrome;
`beforeprint`/`afterprint` reveal it to screen readers only while it is the
visible page). Back on screen the sheet is `display:none` and excluded from
the accessibility tree, so it never duplicates the console.

---

## 5 · Wiring the form

`RFQ_ENDPOINT` appears twice — top of `scripts/quote-flow.js` and top of the
inline script in `equipment.html`. It is empty on purpose.

* **Empty (as delivered):** the form validates, shows the receipt with a
  reference number, and prints the full payload to the console. Good enough to
  test the whole flow; not good enough to lose a real enquiry.
* **Set it** to Formspree, Web3Forms, a Feishu form webhook, or your CRM, and
  the same payload is POSTed as JSON.

The payload already matches the field map in `IMPLEMENTATION-PLAN.md` §7, so an
enquiry can land as one row of your requirements pool: quote number → order
reference, contact → source customer, `technical.*` → requirement statement,
`technical.unit_price` → the baseline you later score quote accuracy against.

Change `FALLBACK_EMAIL` in both places too.

---

## 6 · Before you launch

Brand, domain and contact details are now filled in with the real values
(Xdetron · 无锡艾得创科技有限公司 · www.xdetron.com · +86 180 5193 8829 ·
No. 1015 Xinhong Road, Xinwu District, Wuxi). What is still on you:

1. **Mailboxes.** `rfq@xdetron.com` and `privacy@xdetron.com` are referenced
   but **may not exist yet** — create them on your mail server (or tell the
   developer the real addresses to swap in) before customers hit "send".
2. **Trademark.** Run a trademark search for "Xdetron" / 艾得创 in every market
   you sell to (and in China, classes 7 / 40) before spending on ads.
3. **统一社会信用代码.** `privacy.html` still shows it as a bracketed
   placeholder — fill in the real registration number.
4. **Certifications.** ISO 9001 is *not* claimed anywhere in the copy for this
   reason. Add it only if you hold it, and never publish a mark you cannot
   support with a certificate — this is the single largest legal risk on an
   export site.
5. **Rate tables.** Section 4 above. Non-negotiable.
6. **Tolerance and lead-time claims.** ±0.005 mm, 48-hour fast track and 100 %
   inspection are written as "best achievable / when the shop has room / before
   packing". If you cannot stand behind one, soften it — a claim you cannot
   keep costs more than a modest one.
7. **`og:image`.** There is deliberately no social share image: generating one
   with AI or stock would reintroduce the licensing question this build was
   designed to avoid. Make a 1200 × 630 PNG of a real part you have machined,
   and add `<meta property="og:image" content="…">` to all three pages.
8. **Self-host the fonts** if your customers' IT policies block Google Fonts
   (this also removes the one external request entirely): download the three
   families, put them in `fonts/`, replace the `<link>` in each `<head>` with a
   `@font-face` block.
9. **Delete `.shots/`.**

For deployment on Aliyun see `DEPLOY-ALIYUN.md`.

---

## 7 · Accessibility and QA

Measured, not eyeballed — every pair below was computed, and the ratio is
commented next to the token in `tokens.css`:

| Pair | Ratio |
|---|---|
| body ink `#0E1116` on page `#F4F5F7` | 17.34:1 |
| secondary `#3D434C` on page | 9.14:1 |
| muted `#5A6169` on page / on cards | 5.75 / 5.40:1 |
| accent as text `#0A46C4` on page | 7.17:1 |
| white on accent button `#0A56F0` | 5.83:1 |
| dark-scope ink `#F7F8FA` on `#0A0B0E` | 18.52:1 |
| dark-scope muted `#8A929E` on `#14161A` | 5.77:1 |
| dark-scope accent `#4F8CFF` as text | 5.63:1 |

* **Semantic status is never the only signal** — every DFM note carries a text
  label (OK / watch / risk), not just a colour.
* `--on-accent` flips to near-black in dark mode, where the accent is a light
  blue that white text would fail on.
* Keyboard: the whole console, the enquiry forms and the FAQ are operable
  without a mouse; focus is a 2 px accent ring with 2 px offset, restyled
  inside the dark scope.
* Touch targets ≥ 44 px (quantity shortcut chips are 42 px on mobile).
* All motion is wrapped in `prefers-reduced-motion`; with it set, the drawing
  renders complete, count-ups land on their final value, and transitions
  collapse to 0.001 ms.
* Every animated element ships its final value in the markup, so the page reads
  correctly with JavaScript disabled.
* Verified in headless Chrome 153 at 1440 px and 375 px, light and dark, EN and
  简体中文: **no horizontal overflow at 375 px**, no broken anchors, no duplicate
  IDs, 272/272 bilingual string pairs, all four scripts pass `node --check`,
  CSS braces balanced, no undefined custom properties.

---

## 8 · Known limits

* The enquiry form does not survive a network failure unless you set
  `RFQ_ENDPOINT` — the failure path is implemented, but with no endpoint there
  is nothing to fail.
* Sheet metal is priced from the envelope, which the quote states is a ceiling,
  not a floor. Production prices cut length and bend count.
* Assembly-level STEP files are measured as one solid, so the volume is the
  assembly envelope. The DFM note about dense meshes covers the worst case.
* No search, no order tracking, no account system — deliberately. Those need a
  backend, and a backend is not justified until the enquiry flow has run long
  enough to show whether customers come back.
