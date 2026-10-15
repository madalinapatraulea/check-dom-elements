// Element detection from a screenshot. Runs inside the page via
// page.evaluate(), on the <img id="shot"> element, so it must stay
// self-contained (no imports or outer variables).
//
// 1. Pixels with (almost) the same colour as their neighbour are grouped into
//    regions. Regions that are large and rectangular are "boxes": section
//    backgrounds, buttons, cards, borders.
// 2. Every other pixel is "content" (text, icons, photos). Content pixels
//    close to each other on the same background are joined, so letters form
//    words and lines; lines of the same size close together form paragraphs.
//
// Returns boxes in CSS pixels (image pixels / scale).
export async function detectRegions({ scale, tol, joinX, joinY, minSize }) {
  const img = document.getElementById('shot');
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;

  const parent = new Int32Array(N);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
  };

  // --- 1. Flat colour regions ---------------------------------------------
  for (let i = 0; i < N; i++) parent[i] = i;
  const near = (a, b) => {
    const p = a * 4;
    const q = b * 4;
    return Math.abs(px[p] - px[q]) <= tol && Math.abs(px[p + 1] - px[q + 1]) <= tol && Math.abs(px[p + 2] - px[q + 2]) <= tol;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x + 1 < W && near(i, i + 1)) union(i, i + 1);
      if (y + 1 < H && near(i, i + W)) union(i, i + W);
    }
  }

  // Compact region ids: label[i] = 0..M-1.
  const label = new Int32Array(N);
  const idOf = new Map();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    let id = idOf.get(r);
    if (id === undefined) {
      id = idOf.size;
      idOf.set(r, id);
    }
    label[i] = id;
  }
  const M = idOf.size;
  const count = new Int32Array(M);
  const minX = new Int32Array(M).fill(W);
  const minY = new Int32Array(M).fill(H);
  const maxX = new Int32Array(M).fill(-1);
  const maxY = new Int32Array(M).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = label[y * W + x];
      count[c]++;
      if (x < minX[c]) minX[c] = x;
      if (x > maxX[c]) maxX[c] = x;
      if (y < minY[c]) minY[c] = y;
      if (y > maxY[c]) maxY[c] = y;
    }
  }

  // Rectangularity: per row (and per column) take the span from the first to
  // the last pixel of the region. Holes (text on a button) do not matter, so a
  // rectangle scores ~1, a pill button ~0.95, a patch of sky in a photo less.
  const minBox = 8 * scale;
  const candidate = new Uint8Array(M);
  for (let c = 0; c < M; c++) {
    const bw = maxX[c] - minX[c] + 1;
    const bh = maxY[c] - minY[c] + 1;
    if (bw >= minBox && bh >= minBox && count[c] >= minBox * minBox) candidate[c] = 1;
  }
  const spanSum = (outer, inner, at) => {
    const sum = new Float64Array(M);
    const first = new Int32Array(M);
    const last = new Int32Array(M);
    const seen = new Int32Array(M).fill(-1);
    const touched = [];
    for (let o = 0; o < outer; o++) {
      touched.length = 0;
      for (let k = 0; k < inner; k++) {
        const c = label[at(o, k)];
        if (!candidate[c]) continue;
        if (seen[c] !== o) {
          seen[c] = o;
          first[c] = k;
          touched.push(c);
        }
        last[c] = k;
      }
      for (const c of touched) sum[c] += last[c] - first[c] + 1;
    }
    return sum;
  };
  const rowSpans = spanSum(H, W, (y, x) => y * W + x);
  const colSpans = spanSum(W, H, (x, y) => y * W + x);

  const isBox = new Uint8Array(M);
  const boxes = [];
  for (let c = 0; c < M; c++) {
    if (!candidate[c]) continue;
    const bw = maxX[c] - minX[c] + 1;
    const bh = maxY[c] - minY[c] + 1;
    const area = bw * bh;
    if (rowSpans[c] / area < 0.9 || colSpans[c] / area < 0.9) continue;
    isBox[c] = 1;
    if (bw >= W - 1 && bh >= H - 1) continue; // page background = root
    boxes.push({ kind: 'box', x: minX[c], y: minY[c], w: bw, h: bh });
  }

  // --- 2. Content: everything that is not a box background -----------------
  // 1 = content pixel, 2 = bridge between nearby content on the same background.
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!isBox[label[i]]) mask[i] = 1;

  const bridge = (lineCount, lineLen, at, gapMax) => {
    for (let l = 0; l < lineCount; l++) {
      let last = -1;
      for (let k = 0; k < lineLen; k++) {
        if (mask[at(l, k)] !== 1) continue;
        const gap = k - last - 1;
        if (last >= 0 && gap > 0 && gap <= gapMax) {
          const bg = label[at(l, last + 1)];
          let same = true;
          for (let g = last + 1; g < k && same; g++) same = label[at(l, g)] === bg;
          if (same) for (let g = last + 1; g < k; g++) mask[at(l, g)] = 2;
        }
        last = k;
      }
    }
  };
  bridge(H, W, (y, x) => y * W + x, joinX);
  bridge(W, H, (x, y) => y * W + x, joinY);

  for (let i = 0; i < N; i++) parent[i] = i;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (x + 1 < W && mask[i + 1]) union(i, i + 1);
      if (y + 1 < H && mask[i + W]) union(i, i + W);
    }
  }
  const blobs = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] !== 1) continue; // bounds come from real pixels, not bridges
      const r = find(i);
      let b = blobs.get(r);
      if (!b) blobs.set(r, (b = { x0: x, y0: y, x1: x, y1: y, n: 0 }));
      b.n++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
  }
  let content = [];
  const minPx = minSize * scale;
  for (const b of blobs.values()) {
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    if (w < minPx || h < minPx || b.n < 6) continue;
    content.push({ kind: 'content', x: b.x0, y: b.y0, w, h });
  }

  // Words on the same line join when the space between them is small
  // compared to the text height (so it scales with the font size), and lines
  // of similar height stacked closely form one paragraph.
  const textLike = (b) => b.h <= 80 * scale;
  const shouldMerge = (a, b) => {
    if (!textLike(a) || !textLike(b)) return false;
    const minH = Math.min(a.h, b.h);
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (oy >= 0.5 * minH) {
      const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      return gap >= 0 && gap <= 0.6 * minH;
    }
    if (ox > 0 && Math.max(a.h, b.h) / minH <= 1.5) {
      const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      return gap >= 0 && gap <= 0.8 * minH;
    }
    return false;
  };
  let merged = true;
  while (merged) {
    merged = false;
    content.sort((a, b) => a.y - b.y || a.x - b.x);
    outer: for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        const a = content[i];
        const b = content[j];
        if (b.y > a.y + a.h + a.h) break; // sorted by y: nothing closer below
        if (!shouldMerge(a, b)) continue;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        content[i] = { kind: 'content', x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        content.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }

  const inside = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  const isText = (b) => b.h <= 80 * scale && b.w >= 2 * b.h;
  const isPicture = (b) => !textLike(b);

  // Flat rectangles inside a photo or inside letters (window panes, a wall,
  // the hole of an "O") are not elements. A box is kept there only when it
  // holds its own text, like a button placed over a photo.
  const keptBoxes = boxes.filter((b) => {
    const covered = content.some((c) => c !== b && inside(c, b) && (c.w > b.w || c.h > b.h));
    if (!covered) return true;
    return content.some((c) => isText(c) && inside(b, c) && c.x > b.x + 2 && c.y > b.y + 2 &&
      c.x + c.w < b.x + b.w - 2 && c.y + c.h < b.y + b.h - 2);
  });

  // Content inside a picture is part of the picture, unless it sits in a
  // kept box (the button's label).
  content = content.filter((c) => !content.some((p) => p !== c && isPicture(p) && inside(p, c) &&
    !keptBoxes.some((b) => inside(p, b) && inside(b, c))));

  // Boxes that are the same rectangle within 2px (a border and the area
  // inside it) are one element: keep the outer one.
  keptBoxes.sort((a, b) => b.w * b.h - a.w * a.h);
  const unique = [];
  for (const b of keptBoxes) {
    const dup = unique.some((u) => Math.abs(u.x - b.x) <= 2 && Math.abs(u.y - b.y) <= 2 &&
      Math.abs(u.x + u.w - b.x - b.w) <= 2 && Math.abs(u.y + u.h - b.y - b.h) <= 2);
    if (!dup) unique.push(b);
  }

  const toCss = (v) => Math.round(v / scale);
  return [...unique, ...content].map((b, id) => {
    const out = { id, kind: b.kind, x: toCss(b.x), y: toCss(b.y), w: toCss(b.w), h: toCss(b.h) };
    // Signature used to group repeated gaps: same-size boxes, same-height text.
    out.sig = b.kind === 'box' ? `box|${out.w}x${out.h}` : `content|${Math.round(out.h / 4)}`;
    return out;
  });
}
