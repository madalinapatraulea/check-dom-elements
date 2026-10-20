// Functions that run inside the page via page.evaluate().
// Each one must be self-contained: Playwright serializes it, so it cannot use
// imports or variables from this module.

// Collects the visible "atomic" elements (texts, images, buttons, ...) and
// returns their boxes in document coordinates (CSS pixels).
export function collectBoxes({ scope, minSize }) {
  const ATOMIC = new Set([
    'IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) throw new Error(`Scope "${scope}" not found`);

  const sx = window.scrollX;
  const sy = window.scrollY;
  const docWidth = document.documentElement.scrollWidth;

  const isHidden = (el) => {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0;
  };

  // Intersect a rect with every ancestor that clips its overflow (carousels,
  // sliders), so elements scrolled out of view are cut or dropped.
  const clip = (el, r) => {
    let { left, top, right, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const ar = a.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (cs.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
      if (cs.position === 'fixed') break;
    }
    return { left, top, right, bottom };
  };

  const isTransparent = (c) => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);

  // First background colour behind an element (white by default). Returns
  // null when an image/gradient is behind it, since the colour is unknown.
  const backdrop = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (!isTransparent(cs.backgroundColor)) return cs.backgroundColor;
      if (cs.backgroundImage !== 'none') return null;
    }
    return 'rgb(255, 255, 255)';
  };

  // A background only counts when it differs from what is behind it, so
  // invisible wrappers (white on white) are not measured.
  const isVisualBox = (el) => {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' &&
          !isTransparent(cs[`border${side}Color`])) return true;
    }
    return !isTransparent(cs.backgroundColor) && cs.backgroundColor !== backdrop(el);
  };

  // Structural signature: tag + classes of the element and its two nearest
  // ancestors. Repeated components (cards, footer links) share it.
  const signature = (el) => {
    const parts = [];
    for (let a = el, i = 0; a && a !== document.body && i < 3; a = a.parentElement, i++) {
      const cls = typeof a.className === 'string'
        ? a.className.trim().split(/\s+/).filter(Boolean).map((c) => c.replace(/\d+/g, '#')).sort().join('.')
        : '';
      parts.push(a.tagName.toLowerCase() + (cls ? '.' + cls : ''));
    }
    return parts.join('<');
  };

  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 2).join('.');
    return s;
  };

  const boxes = [];
  const seen = new Set();

  // Font as declared in CSS. The font actually rendered is looked up later
  // through DevTools (see resolveFonts in measure.js), via data-sm-id.
  const fontOf = (el) => {
    const cs = getComputedStyle(el);
    return {
      declared: cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
      size: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      weight: cs.fontWeight,
    };
  };
  const HAS_FONT = new Set(['text', 'button', 'input', 'select', 'textarea']);

  const add = (el, r, kind, text) => {
    const original = (r.right - r.left) * (r.bottom - r.top);
    const c = clip(el, r);
    const w = c.right - c.left;
    const h = c.bottom - c.top;
    if (w < minSize || h < minSize) return;
    // Mostly hidden by a clipping parent (e.g. off-screen carousel slide).
    if (original > 0 && (w * h) / original < 0.5) return;
    const box = {
      x: Math.round(c.left + sx),
      y: Math.round(c.top + sy),
      w: Math.round(w),
      h: Math.round(h),
    };
    if (box.x + box.w <= 0 || box.x >= docWidth) return;
    const key = `${box.x},${box.y},${box.w},${box.h}`;
    if (seen.has(key)) return;
    seen.add(key);
    const b = { id: boxes.length, kind, selector: describe(el), sig: `${kind}|${signature(el)}`, text, ...box };
    const font = HAS_FONT.has(kind) && (text || kind !== 'text') ? fontOf(el) : null;
    // font-size: 0 is a common way to hide text (icon buttons): no label.
    if (font && font.size > 0) {
      b.font = font;
      el.setAttribute('data-sm-id', b.id);
    }
    boxes.push(b);
  };

  const walk = (el) => {
    if (SKIP.has(el.tagName.toUpperCase()) || isHidden(el)) return;
    const tag = el.tagName.toUpperCase();

    // Elements that are visible only through their own background, border
    // or shadow (sections, banners, cards, button frames).
    if (isVisualBox(el)) {
      add(el, el.getBoundingClientRect(), 'box', '');
    }

    if (ATOMIC.has(tag) || el.getAttribute('role') === 'button') {
      const label = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim();
      add(el, el.getBoundingClientRect(), tag === 'IMG' || tag === 'PICTURE' ? 'image' : tag.toLowerCase(), label.slice(0, 60));
      return;
    }

    // Text width comes from the text itself (Range), so short text in a wide
    // block is not stretched. Text height is the line box (line-height), as
    // DevTools shows it, not the font's glyph height.
    const range = document.createRange();
    const textRect = (nodes, lineHeight) => {
      let r = null;
      for (const n of nodes) {
        range.selectNodeContents(n);
        for (const cr of range.getClientRects()) {
          if (cr.width === 0 || cr.height === 0) continue;
          const top = lineHeight ? cr.top + (cr.height - lineHeight) / 2 : cr.top;
          const bottom = lineHeight ? top + lineHeight : cr.bottom;
          r = r
            ? { left: Math.min(r.left, cr.left), top: Math.min(r.top, top), right: Math.max(r.right, cr.right), bottom: Math.max(r.bottom, bottom) }
            : { left: cr.left, top, right: cr.right, bottom };
        }
      }
      return r;
    };

    // A block whose content is only inline (e.g. <p>Hi <b>there</b></p>) is
    // one text unit; otherwise "Hi" and "there" would be measured apart.
    // Vertically it spans the block's content box (without padding/border).
    const allInline = [...el.querySelectorAll('*')].every((d) => {
      if (ATOMIC.has(d.tagName.toUpperCase())) return false;
      const disp = getComputedStyle(d).display;
      return disp === 'inline' || disp === 'contents' || disp === 'none';
    });
    if (allInline && el.textContent.trim()) {
      const r = textRect([el]);
      if (r) {
        const cs = getComputedStyle(el);
        const br = el.getBoundingClientRect();
        if (!cs.display.startsWith('inline')) {
          r.top = br.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
          r.bottom = br.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
        }
        add(el, r, 'text', el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60));
      }
      return;
    }

    const textNodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (textNodes.length) {
      const lh = parseFloat(getComputedStyle(el).lineHeight); // NaN for "normal"
      const r = textRect(textNodes, Number.isNaN(lh) ? null : lh);
      if (r) add(el, r, 'text', textNodes.map((n) => n.textContent.trim()).join(' ').slice(0, 60));
    }

    for (const child of el.children) walk(child);
  };

  walk(root);
  return boxes;
}

// Draws the highlight overlay on top of the page. Coordinates are document
// coordinates, so the overlay is positioned absolutely against <html>.
export function drawHighlights({ boxes, color }) {
  let layer = document.getElementById('__spacing_overlay__');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = '__spacing_overlay__';
    // Sized to the page and clipped, so labels near the edge cannot make the
    // page (and the screenshot) wider.
    const { scrollWidth, scrollHeight } = document.documentElement;
    layer.style.cssText = `position:absolute;left:0;top:0;width:${scrollWidth}px;height:${scrollHeight}px;` +
      'overflow:hidden;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(layer);
  }
  for (const b of boxes) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;` +
      `background:${color}55;outline:1px solid ${color};box-sizing:border-box;`;
    layer.appendChild(d);
  }
}

// Draws a line with end caps and a "Npx" label for every measured gap
// (red between elements, blue for padding to the container). Labels never
// overlap: each one tries a few spots around its line, and a gap with no free
// spot is skipped. Returns how many gaps were drawn.
export function drawGaps({ gaps, colors }) {
  const layer = document.getElementById('__spacing_overlay__');
  const el = (css, text) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;' + css;
    if (text) d.textContent = text;
    layer.appendChild(d);
    return d;
  };
  const placed = [];
  const hits = (r) => placed.some((p) => r.left < p.right + 1 && r.right > p.left - 1 && r.top < p.bottom + 1 && r.bottom > p.top - 1);

  // Short gaps first, so dense areas get their labels before long lines
  // claim the space.
  const ordered = [...gaps].sort((a, b) => a.px - b.px);
  let drawn = 0;

  for (const g of ordered) {
    const color = colors[g.kind];
    const text = g.count > 1 ? `${g.px}px ×${g.count}` : `${g.px}px`;
    const label = el('background:' + color + ';color:#fff;font:600 10px/1 system-ui,sans-serif;' +
      'padding:2px 3px;border-radius:2px;white-space:nowrap;left:0;top:0;', text);
    const { width: lw, height: lh } = label.getBoundingClientRect();
    const mid = g.from + g.px / 2;

    // Candidate label positions (left, top) around the middle of the line.
    const spots = g.axis === 'y'
      ? [[g.at + 4, mid - lh / 2], [g.at - lw - 4, mid - lh / 2], [g.at + 4, mid - lh - 2], [g.at - lw - 4, mid + 2]]
      : [[mid - lw / 2, g.at - lh - 3], [mid - lw / 2, g.at + 4], [mid - lw - 2, g.at - lh - 3], [mid + 2, g.at + 4]];
    const spot = spots
      .map(([x, y]) => ({ left: x, top: y, right: x + lw, bottom: y + lh }))
      .find((r) => !hits(r));
    if (!spot) {
      label.remove();
      continue;
    }
    placed.push(spot);
    label.style.left = `${spot.left}px`;
    label.style.top = `${spot.top}px`;
    drawn++;

    if (g.axis === 'y') {
      el(`left:${g.at}px;top:${g.from}px;width:1px;height:${g.px}px;background:${color};`);
      el(`left:${g.at - 3}px;top:${g.from}px;width:7px;height:1px;background:${color};`);
      el(`left:${g.at - 3}px;top:${g.to - 1}px;width:7px;height:1px;background:${color};`);
    } else {
      el(`top:${g.at}px;left:${g.from}px;height:1px;width:${g.px}px;background:${color};`);
      el(`top:${g.at - 3}px;left:${g.from}px;height:7px;width:1px;background:${color};`);
      el(`top:${g.at - 3}px;left:${g.to - 1}px;height:7px;width:1px;background:${color};`);
    }
    // Keep labels above all lines.
    layer.appendChild(label);
  }
  return drawn;
}

// Draws a fresh overlay with every text outlined and labelled with its font
// ("Montserrat 16px 600"). Labels never overlap, like drawGaps; a text whose
// label has no free spot is skipped. Returns how many labels were drawn.
export function drawFonts({ items, color, warnColor }) {
  document.getElementById('__spacing_overlay__')?.remove();
  const layer = document.createElement('div');
  layer.id = '__spacing_overlay__';
  const { scrollWidth, scrollHeight } = document.documentElement;
  layer.style.cssText = `position:absolute;left:0;top:0;width:${scrollWidth}px;height:${scrollHeight}px;` +
    'overflow:hidden;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(layer);

  const el = (css, text) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;' + css;
    if (text) d.textContent = text;
    layer.appendChild(d);
    return d;
  };
  const placed = [];
  const hits = (r) => placed.some((p) => r.left < p.right + 1 && r.right > p.left - 1 && r.top < p.bottom + 1 && r.bottom > p.top - 1);

  let drawn = 0;
  for (const it of items) {
    const c = it.fallback ? warnColor : color;
    el(`left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;outline:1px dashed ${c};box-sizing:border-box;`);
    const text = it.count > 1 ? `${it.label} ×${it.count}` : it.label;
    const label = el('background:' + c + ';color:#fff;font:600 10px/1 system-ui,sans-serif;' +
      'padding:2px 3px;border-radius:2px;white-space:nowrap;left:0;top:0;', text);
    const { width: lw, height: lh } = label.getBoundingClientRect();
    // Candidate spots: above the text, below it, inside its top-left corner,
    // above it aligned right.
    const spots = [
      [it.x, it.y - lh - 1], [it.x, it.y + it.h + 1], [it.x + 1, it.y + 1], [it.x + it.w - lw, it.y - lh - 1],
    ];
    const spot = spots
      .map(([x, y]) => ({ left: x, top: y, right: x + lw, bottom: y + lh }))
      .find((r) => !hits(r));
    if (!spot) {
      label.remove();
      continue;
    }
    placed.push(spot);
    label.style.left = `${spot.left}px`;
    label.style.top = `${spot.top}px`;
    drawn++;
  }
  // Labels above all outlines.
  for (const l of [...layer.children].filter((d) => d.textContent)) layer.appendChild(l);
  return drawn;
}
