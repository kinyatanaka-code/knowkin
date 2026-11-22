// 提案資料の「見た目」を、文字だけでなくデータで残す（2026-11-22 田中さん「資料の読み取りってテキストだけではなく、デザインの感じもデータで渡せるように保存して欲しい」
//   「部品は増やして欲しいけどお金がかからないように作ってね」）。
//
// しくみ：kinbot に入っている提案資料の PDF（と、Apps Script が書き出して送ってくる Google スライドの PDF）を、
//   knowkin の中で1ページずつ絵にして、色・文字の大きさ・置き場所・箱・線・画像の場所などの「部品」を数える。
//   AI は使わない（お金がかからない）。絵は小さい JPEG（横640）で残し、数えた部品は JSON で残す。
//   1時間に3件ずつ進めるので、サーバーの負担も小さい。
import { pool } from './db.js';
import { kinbotConfig } from './kinbot-sync.js';

const IMG_W = 640;        // 残す絵の横幅（Gemini・Claude が見た目をつかめて、データベースが重くならない大きさ）
const IMG_Q = 62;
const MAX_PAGES = 40;     // 1つの資料で見るページの上限
const PER_RUN = 3;        // 1回（1時間）で見る資料の数

let ready = false;
async function ensure() {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS deck_designs (
    user_id INT NOT NULL, ref TEXT NOT NULL, source TEXT, name TEXT, company TEXT, day TEXT, pages INT,
    summary JSONB, error TEXT, tries INT DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (user_id, ref))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS deck_pages (
    user_id INT NOT NULL, ref TEXT NOT NULL, page INT NOT NULL, design JSONB, image BYTEA, text TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (user_id, ref, page))`);
  ready = true;
}

// ---- pdf.js を Node で動かす（絵をかく道具を先に渡しておかないと、図形の色の指定で止まる）----
let pdfjsP = null;
async function libs() {
  if (!pdfjsP) pdfjsP = (async () => {
    const napi = await import('@napi-rs/canvas');
    globalThis.Path2D ??= napi.Path2D; globalThis.DOMMatrix ??= napi.DOMMatrix; globalThis.ImageData ??= napi.ImageData;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return { pdfjs, createCanvas: napi.createCanvas };
  })();
  return pdfjsP;
}

// ---- 色の計算 ----
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
// 色の呼び名（人が読んでも分かるように）
export function colorName(h) {
  const c = rgbOf(h), s = sat(c), l = lum(c);
  if (s < 0.12) return l > 0.93 ? '白' : l > 0.7 ? '薄いグレー' : l > 0.35 ? 'グレー' : l > 0.12 ? '濃いグレー' : '黒';
  const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let hue = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
  hue = (hue * 60 + 360) % 360;
  const base = hue < 15 ? '赤' : hue < 40 ? 'オレンジ' : hue < 65 ? '黄' : hue < 160 ? '緑' : hue < 195 ? '青緑' : hue < 255 ? '青' : hue < 290 ? '紫' : hue < 335 ? 'ピンク' : '赤';
  return (l < 0.3 ? '濃い' : l > 0.8 ? '薄い' : '') + base;
}

// 絵から、使われている色の割合を数える（似た色はまとめる）
function paletteOf(img, w, h) {
  const d = img.data, cnt = new Map(), border = new Map();
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4; const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const o = cnt.get(k) || [0, 0, 0, 0]; o[0]++; o[1] += d[i]; o[2] += d[i + 1]; o[3] += d[i + 2]; cnt.set(k, o);
    if (x < 6 || y < 6 || x > w - 8 || y > h - 8) border.set(k, (border.get(k) || 0) + 1);
  }
  const total = [...cnt.values()].reduce((s, o) => s + o[0], 0) || 1;
  const groups = [];
  for (const [k, o] of [...cnt.entries()].sort((a, b) => b[1][0] - a[1][0])) {
    const c = [o[1] / o[0], o[2] / o[0], o[3] / o[0]];
    const g = groups.find((x) => dist(x.c, c) < 38);
    if (g) { g.n += o[0]; g.keys.push(k); } else if (groups.length < 40) groups.push({ c, n: o[0], keys: [k] });
  }
  const bgKey = [...border.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const bgG = groups.find((g) => g.keys.includes(bgKey)) || groups[0];
  const palette = groups.filter((g) => g.n / total >= 0.004).slice(0, 8).map((g) => ({ hex: hex(...g.c), share: Math.round((g.n / total) * 1000) / 10 }));
  return { palette, bg: bgG ? hex(...bgG.c) : '#ffffff', bgShare: bgG ? Math.round((bgG.n / total) * 100) : 0 };
}

// ---- 行列（pdf.js と同じ向き：t(m1, m2) は m2 を先にかける）----
const T = (m1, m2) => [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
const P = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function boxOf(m, x0, y0, x1, y1) {
  const ps = [P(m, x0, y0), P(m, x1, y0), P(m, x0, y1), P(m, x1, y1)];
  return [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))];
}

// 図形・画像・文字の色を、描く順の命令（operator list）から拾う
function walkOps(pdfjs, ol) {
  const O = pdfjs.OPS;
  const st = []; let g = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000', alpha: 1, pattern: false };
  let path = null, tm = [1, 0, 0, 1, 0, 0], tlm = tm, fsize = 12, font = '', leading = 0;
  const shapes = [], images = [], runs = [];
  const col = (a) => (a && a.length >= 3 ? hex(a[0], a[1], a[2]) : null);
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    switch (fn) {
      case O.save: st.push({ ...g }); break;
      case O.restore: g = st.pop() || g; break;
      case O.transform: g.ctm = T(g.ctm, a); break;
      case O.paintFormXObjectBegin: st.push({ ...g }); if (Array.isArray(a?.[0]) && a[0].length === 6) g.ctm = T(g.ctm, a[0]); break;
      case O.paintFormXObjectEnd: g = st.pop() || g; break;
      case O.setFillRGBColor: g.fill = col(a) || g.fill; g.pattern = false; break;
      case O.setStrokeRGBColor: g.stroke = col(a) || g.stroke; break;
      case O.setFillColorN: if (a && (a[0] === 'Shading' || a[0] === 'TilingPattern' || typeof a[0] === 'string')) g.pattern = true; break;
      case O.setGState: for (const [k, v] of a?.[0] || []) if (k === 'ca') g.alpha = v; break;
      case O.constructPath: {
        const ops = a[0] || [], mm = a[2];
        if (!mm || mm.length < 4 || !Number.isFinite(mm[0])) break;
        const b = boxOf(g.ctm, mm[0], mm[1], mm[2], mm[3]);
        const curve = ops.some((o) => o === O.curveTo || o === O.curveTo2 || o === O.curveTo3), rect = ops.includes(O.rectangle), line = ops.includes(O.lineTo);
        path = path ? { b: [Math.min(path.b[0], b[0]), Math.min(path.b[1], b[1]), Math.max(path.b[2], b[2]), Math.max(path.b[3], b[3])], curve: path.curve || curve, rect: path.rect || rect, line: path.line || line }
          : { b, curve, rect, line };
        break;
      }
      case O.fill: case O.eoFill: case O.fillStroke: case O.eoFillStroke: case O.closeFillStroke: case O.closeEOFillStroke:
        if (path) shapes.push({ b: path.b, fill: g.pattern ? 'グラデーション' : g.fill, alpha: g.alpha, kind: path.curve && !path.line && !path.rect ? 'oval' : path.curve ? 'round' : path.rect ? 'rect' : 'path',
          stroke: fn === O.fill || fn === O.eoFill ? null : g.stroke });
        path = null; break;
      case O.stroke: case O.closeStroke:
        if (path) shapes.push({ b: path.b, fill: null, stroke: g.stroke, alpha: g.alpha, kind: 'line' }); path = null; break;
      case O.endPath: path = null; break;
      case O.shadingFill: shapes.push({ b: boxOf(g.ctm, 0, 0, 1, 1), fill: 'グラデーション', alpha: g.alpha, kind: 'rect', whole: true }); break;
      case O.paintImageXObject: case O.paintInlineImageXObject: case O.paintImageMaskXObject: case O.paintImageXObjectRepeat:
        images.push(boxOf(g.ctm, 0, 0, 1, 1)); break;
      case O.beginText: tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case O.setFont: font = a[0]; fsize = a[1]; break;
      case O.setLeading: leading = a[0]; break;
      case O.setTextMatrix: tm = tlm = a.slice(0, 6); break;
      case O.moveText: case O.setLeadingMoveText: tlm = T(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = tlm; if (fn === O.setLeadingMoveText) leading = -a[1]; break;
      case O.nextLine: tlm = T(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; break;
      case O.showText: case O.showSpacedText: case O.nextLineShowText: case O.nextLineSetSpacingShowText: {
        const glyphs = fn === O.nextLineSetSpacingShowText ? a[2] : a[0];
        if (fn === O.nextLineShowText || fn === O.nextLineSetSpacingShowText) { tlm = T(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; }
        const m = T(g.ctm, tm); const [x, y] = P(m, 0, 0);
        let adv = 0;
        for (const gl of glyphs || []) adv += typeof gl === 'number' ? -gl / 1000 : (gl?.width || 0) / 1000;
        runs.push({ x, y, color: g.fill, font, size: fsize * Math.hypot(m[2], m[3]) });
        tm = T(tm, [1, 0, 0, 1, adv * fsize, 0]);
        break;
      }
      default: break;
    }
  }
  return { shapes, images, runs };
}

const pct = (v, all) => Math.round((v / all) * 1000) / 10;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const cleanFont = (n) => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/[-,](Regular|Normal|Roman|W3|R)$/i, '').slice(0, 40);

/** 1ページの部品を数える */
async function analyzePage(L, doc, no) {
  const { pdfjs, createCanvas } = L;
  const page = await doc.getPage(no);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  // 絵（残す用）
  const sc = IMG_W / W, v2 = page.getViewport({ scale: sc });
  const canvas = createCanvas(Math.ceil(v2.width), Math.ceil(v2.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: v2 }).promise;
  const pal = paletteOf(ctx.getImageData(0, 0, canvas.width, canvas.height), canvas.width, canvas.height);
  const jpg = await canvas.encode('jpeg', IMG_Q);
  // 命令（色・図形・画像）と文字
  const ol = await page.getOperatorList();
  const { shapes, images, runs } = walkOps(pdfjs, ol);
  const tc = await page.getTextContent();
  const fontInfo = (id) => { try { const f = page.commonObjs.has(id) ? page.commonObjs.get(id) : null; return f ? { name: cleanFont(f.name || f.fallbackName), bold: Boolean(f.bold || /bold|heavy|black|W[6-9]|-B\b|-H\b|Medium/i.test(f.name || '')) } : null; } catch { return null; } };
  // ユーザー空間 → ページの左上からの割合（%）
  const toPct = (b) => { const r = vp.convertToViewportRectangle(b); const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]), x1 = Math.max(r[0], r[2]), y1 = Math.max(r[1], r[3]);
    return { x: pct(Math.max(0, x0), W), y: pct(Math.max(0, y0), H), w: pct(Math.min(W, x1) - Math.max(0, x0), W), h: pct(Math.min(H, y1) - Math.max(0, y0), H) }; };

  // 文字：1行ずつ（同じ大きさ・同じ高さの続きはつなぐ）
  const lines = [];
  for (const it of tc.items) {
    const s = String(it.str || '').normalize('NFKC'); if (!s.trim() && !lines.length) continue;
    const t = it.transform, size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
    const near = runs.reduce((best, r) => { const d = Math.hypot(r.x - t[4], r.y - t[5]); return d < best.d ? { d, r } : best; }, { d: 1e9, r: null });
    const color = near.r && near.d < Math.max(3, size) ? near.r.color : null;
    const fi = fontInfo(it.fontName) || { name: cleanFont(tc.styles?.[it.fontName]?.fontFamily), bold: false };
    const last = lines[lines.length - 1];
    const bx = [t[4], t[5] - size * 0.2, t[4] + (it.width || 0), t[5] + size * 0.9];
    if (last && Math.abs(last.size - size) < 0.6 && Math.abs(last.y0 - t[5]) < size * 0.3 && t[4] - last.b[2] < size * 0.6) {
      last.t += s; last.b[2] = Math.max(last.b[2], bx[2]); if (!last.color && color) last.color = color; continue;
    }
    if (!s.trim()) continue;
    lines.push({ t: s, size, color, font: fi.name, bold: fi.bold, b: bx, y0: t[5] });
  }
  const texts = lines.map((l) => ({ t: l.t.trim().slice(0, 50), size: Math.round(l.size * 10) / 10, color: l.color, font: l.font, bold: l.bold, ...toPct(l.b) }))
    .filter((l) => l.t);
  const chars = texts.reduce((s, l) => s + l.t.length, 0);
  // 文字の大きさの段（本文＝いちばん多く使われる大きさ、見出し＝上の方にある大きい文字）
  const bySize = new Map(); for (const l of texts) bySize.set(l.size, (bySize.get(l.size) || 0) + l.t.length);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const titleCand = texts.filter((l) => l.size >= body * 1.25 || texts.length <= 3).sort((a, b) => (a.y < 35 ? 0 : 1) - (b.y < 35 ? 0 : 1) || b.size - a.size);
  const title = titleCand[0] || null;
  // 図形：ページ全体を覆うものは背景、とても小さいものは飾り。箱（カード）・線・丸に分ける
  const area = (p) => (p.w * p.h) / 100;
  const parts = shapes.filter((s) => s.alpha > 0.1).map((s) => ({ ...toPct(s.b), fill: s.fill, stroke: s.stroke, kind: s.kind, alpha: s.alpha }))
    .filter((s) => s.w > 0 && s.h > 0);
  const bgShapes = parts.filter((s) => area(s) >= 85 && s.fill);
  const lineParts = parts.filter((s) => s.kind === 'line' || (Math.min(s.w, s.h) < 0.8 && Math.max(s.w, s.h) > 5));
  const boxes = parts.filter((s) => !bgShapes.includes(s) && !lineParts.includes(s) && s.fill && area(s) >= 0.6)
    .map((s) => ({ ...s, kind: s.kind === 'oval' ? (Math.abs(s.w * W - s.h * H) < Math.min(s.w * W, s.h * H) * 0.15 ? 'circle' : 'oval') : s.kind === 'round' ? 'round' : s.kind === 'path' ? 'shape' : 'rect' }));
  const uniq = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const boxList = uniq(boxes.sort((a, b) => area(b) - area(a)), (s) => `${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.w)},${Math.round(s.h)}`).slice(0, 30);
  const imgs = uniq(images.map(toPct).filter((p) => p.w > 1 && p.h > 1), (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.w)}`).slice(0, 15);
  const imgCover = Math.min(100, Math.round(imgs.reduce((s, p) => s + area(p), 0)));
  // 置き方：余白・中央寄せ・段の数
  const xs = texts.map((l) => l.x), xe = texts.map((l) => l.x + l.w), ys = texts.map((l) => l.y), ye = texts.map((l) => l.y + l.h);
  const centered = texts.filter((l) => Math.abs(l.x + l.w / 2 - 50) < 4 && l.w < 90).length;
  const starts = []; for (const x of xs.sort((a, b) => a - b)) if (!starts.length || x - starts[starts.length - 1] > 12) starts.push(x);
  const colStarts = starts.filter((s) => xs.filter((x) => Math.abs(x - s) < 12).length >= 2);
  const all = texts.map((l) => l.t).join(' ');
  // ページの種類
  let kind = '本文';
  if (/目次|アジェンダ|agenda|contents|index/i.test(all) && texts.length <= 25) kind = '目次';
  else if (no === 1 || (/御中|提案書|ご提案資料|御提案資料/.test(all) && texts.length <= 8)) kind = '表紙';
  else if (/ありがとうございました|お問い合わせ|thank you/i.test(all) && texts.length <= 10) kind = '締め';
  else if (imgCover >= 40) kind = '画像中心';
  else if ((colStarts.length >= 3 && texts.length >= 12) || (lineParts.length >= 6 && texts.length >= 4)) kind = '表・並べ';
  else if (boxList.length >= 3) kind = 'カード';
  else if (texts.length <= 4 && chars <= 40) kind = '区切り';
  const design = {
    page: no, kind, size: { w: Math.round(W), h: Math.round(H) },
    bg: bgShapes.length && bgShapes[bgShapes.length - 1].fill !== 'グラデーション' ? bgShapes[bgShapes.length - 1].fill : pal.bg,
    bgGradient: bgShapes.some((s) => s.fill === 'グラデーション') || undefined,
    blank: pal.bgShare, palette: pal.palette,
    title: title ? { t: title.t, size: title.size, color: title.color, bold: title.bold, font: title.font, x: title.x, y: title.y, align: Math.abs(title.x + title.w / 2 - 50) < 4 ? '中央' : title.x > 55 ? '右' : '左' } : null,
    sizes: { title: title ? title.size : 0, body, small: Math.min(...texts.map((l) => l.size), body || 0) },
    textColors: [...texts.reduce((m, l) => (l.color ? m.set(l.color, (m.get(l.color) || 0) + l.t.length) : m), new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c),
    fonts: [...new Set(texts.map((l) => l.font).filter(Boolean))].slice(0, 5),
    layout: { margin: texts.length ? { left: Math.round(Math.min(...xs)), top: Math.round(Math.min(...ys)), right: Math.round(100 - Math.max(...xe)), bottom: Math.round(100 - Math.max(...ye)) } : null,
      columns: Math.max(1, colStarts.length), centered: texts.length ? Math.round((centered / texts.length) * 100) : 0, chars, lines: texts.length },
    boxes: boxList, lines: lineParts.slice(0, 15).map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, color: s.stroke || s.fill })), images: imgs, imageCover: imgCover,
    texts: texts.slice(0, 40),
  };
  page.cleanup();
  return { design, jpg, text: all.slice(0, 2000) };
}

// 資料全体の「型」（よく使う色・文字の大きさ・字体・表紙の作り・ページの種類の流れ）
function summarize(pages) {
  const colorW = new Map();
  for (const p of pages) for (const c of p.palette || []) {
    const k = [...colorW.keys()].find((x) => dist(rgbOf(x), rgbOf(c.hex)) < 30) || c.hex;
    colorW.set(k, (colorW.get(k) || 0) + c.share);
  }
  const colors = [...colorW.entries()].sort((a, b) => b[1] - a[1]).map(([h, s]) => ({ hex: h, name: colorName(h), share: Math.round(s / pages.length) }));
  const vivid = colors.filter((c) => sat(rgbOf(c.hex)) > 0.25 && lum(rgbOf(c.hex)) < 0.85);
  const textCol = new Map(); for (const p of pages) for (const t of p.texts || []) if (t.color) textCol.set(t.color, (textCol.get(t.color) || 0) + t.t.length);
  const fonts = new Map(); for (const p of pages) for (const t of p.texts || []) if (t.font) fonts.set(t.font, (fonts.get(t.font) || 0) + t.t.length);
  const w = pages[0]?.size?.w || 0, h = pages[0]?.size?.h || 1, r = w / h;
  const aspect = Math.abs(r - 16 / 9) < 0.06 ? '16:9（横）' : Math.abs(r - 4 / 3) < 0.06 ? '4:3（横）' : Math.abs(r - 1.414) < 0.05 ? 'A4横' : Math.abs(r - 0.707) < 0.05 ? 'A4縦' : `${w}×${h}`;
  const cover = pages[0];
  const kinds = new Map(); for (const p of pages) kinds.set(p.kind, (kinds.get(p.kind) || 0) + 1);
  return {
    aspect, pages: pages.length,
    colors: colors.slice(0, 6), main: vivid[0]?.hex || null, accent: vivid[1]?.hex || null,
    bg: median(pages.map((p) => lum(rgbOf(p.bg || '#ffffff')))) > 0.5 ? '明るい地' : '暗い地', bgColors: [...new Set(pages.map((p) => p.bg))].slice(0, 4),
    text: [...textCol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c),
    fonts: [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f),
    sizes: { title: Math.round(median(pages.filter((p) => p.sizes.title).map((p) => p.sizes.title))), body: Math.round(median(pages.filter((p) => p.sizes.body).map((p) => p.sizes.body))) },
    titleAt: (() => { const a = pages.filter((p) => p.title && p.kind !== '表紙'); const al = new Map(); for (const p of a) al.set(p.title.align, (al.get(p.title.align) || 0) + 1);
      return { align: [...al.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '', y: Math.round(median(a.map((p) => p.title.y))), x: Math.round(median(a.map((p) => p.title.x))) }; })(),
    margin: Math.round(median(pages.filter((p) => p.layout.margin).map((p) => p.layout.margin.left))),
    chars: Math.round(median(pages.map((p) => p.layout.chars))),
    blank: Math.round(median(pages.map((p) => p.blank))),
    boxes: Math.round((pages.reduce((s, p) => s + p.boxes.length, 0) / (pages.length || 1)) * 10) / 10,
    rounded: pages.some((p) => p.boxes.some((b) => b.kind === 'round' || b.kind === 'circle')),
    images: pages.filter((p) => p.images.length).length,
    cover: cover ? { bg: cover.bg, title: cover.title, kind: cover.kind } : null,
    kinds: Object.fromEntries(kinds), flow: pages.map((p) => p.kind),
  };
}

/** PDF を見て、ページごとの部品と絵を返す（データベースは使わない） */
export async function analyzePdf(pdf, onPage) {
  const L = await libs();
  const doc = await L.pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const n = Math.min(doc.numPages, MAX_PAGES), designs = [];
    for (let i = 1; i <= n; i++) {
      const r = await analyzePage(L, doc, i);
      designs.push(r.design);
      if (onPage) await onPage(i, r);
    }
    return { pages: n, designs, summary: summarize(designs) };
  } finally { await doc.destroy().catch(() => {}); }
}

// 別のプロセスで数える（落ちても本体は止まらない。3分で打ち切る）
async function analyzeInChild(pdf) {
  const [{ fork }, fs, os, path, url] = await Promise.all([import('node:child_process'), import('node:fs/promises'), import('node:os'), import('node:path'), import('node:url')]);
  const file = path.join(os.tmpdir(), `knowkin-deck-${process.pid}-${Date.now()}.pdf`);
  await fs.writeFile(file, pdf);
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(url.fileURLToPath(new URL('./deck-worker.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=512'] });
      let err = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('3分たっても数え終わらなかったので止めました')); } }, 180000);
      child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
      child.on('message', (m) => { if (done) return; done = true; clearTimeout(timer); m.ok ? resolve(m) : reject(new Error(m.error)); });
      child.on('exit', (code, sig) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`数える途中で止まりました（${sig || code}）${err ? '：' + err.trim().split('\n').pop() : ''}`)); });
      child.send({ file });
    });
  } finally { await fs.unlink(file).catch(() => {}); }
}

// 数える作業は1つずつ（同時にいくつも動かして、サーバーの手が足りなくならないように）
let chain = Promise.resolve();
function oneAtATime(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

/** PDF を見て、部品を数えて残す */
export async function saveDeck(uid, { ref, source, name, company, day, pdf }) {
  await ensure();
  const r = await oneAtATime(() => analyzeInChild(pdf));
  for (const p of r.pages) {
    await pool.query(`INSERT INTO deck_pages(user_id, ref, page, design, image, text) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, ref, page) DO UPDATE SET design = EXCLUDED.design, image = EXCLUDED.image, text = EXCLUDED.text, updated_at = now()`,
    [uid, ref, p.i, JSON.stringify(r.designs[p.i - 1]), Buffer.from(p.jpg, 'base64'), p.text]);
  }
  const n = r.designs.length;
  await pool.query(`INSERT INTO deck_designs(user_id, ref, source, name, company, day, pages, summary, error, tries) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,1)
    ON CONFLICT (user_id, ref) DO UPDATE SET source = EXCLUDED.source, name = EXCLUDED.name, company = EXCLUDED.company, day = EXCLUDED.day, pages = EXCLUDED.pages,
      summary = EXCLUDED.summary, error = NULL, tries = deck_designs.tries + 1, updated_at = now()`,
  [uid, ref, source || 'kinbot', String(name || '').slice(0, 200), String(company || '').slice(0, 200), day || null, n, JSON.stringify(r.summary)]);
  return { ref, pages: n, summary: r.summary };
}
async function markFailed(uid, d, msg) {
  await pool.query(`INSERT INTO deck_designs(user_id, ref, source, name, company, day, error, tries) VALUES($1,$2,$3,$4,$5,$6,$7,1)
    ON CONFLICT (user_id, ref) DO UPDATE SET error = EXCLUDED.error, tries = deck_designs.tries + 1, updated_at = now()`,
  [uid, d.ref, d.source, String(d.name || '').slice(0, 200), String(d.company || '').slice(0, 200), d.day || null, String(msg).slice(0, 300)]);
}

async function library() {
  const { callUpstream } = await import('./upstream.js');
  const r = await callUpstream('kinbot', 'get_proposal_library', { limit: 60 }, 50_000_000);
  try { return JSON.parse((r.content || []).map((c) => c.text || '').join('\n')); } catch { return { sent: [], slides: [] }; }
}

/** 1時間ごと：まだ見ていない kinbot の提案資料（PDF）を3件まで見る */
export async function syncDeckDesigns(uid, { max = PER_RUN } = {}) {
  const cfg = kinbotConfig(); if (!cfg.ready) return { skipped: 'kinbot が設定されていません' };
  await ensure();
  const lib = await library();
  const { rows } = await pool.query('SELECT ref, tries, error FROM deck_designs WHERE user_id = $1', [uid]);
  const done = new Map(rows.map((r) => [r.ref, r]));
  const todo = (lib.sent || []).map((d) => ({ ref: `pdf:${d.id}`, id: d.id, source: 'kinbot', name: d.name, company: d.companies, day: d.day }))
    .filter((d) => { const x = done.get(d.ref); return !x || (x.error && x.tries < 3); }).slice(0, max);
  const out = [];
  for (const d of todo) {
    try {
      const r = await fetch(`${cfg.url}/api/knowkin/doc-file?id=${encodeURIComponent(d.id)}`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`kinbot から PDF を読めませんでした（${r.status}）`);
      const s = await saveDeck(uid, { ...d, pdf: Buffer.from(await r.arrayBuffer()) });
      out.push(`${d.name}：${s.pages}ページ`);
    } catch (e) { await markFailed(uid, d, e.message); out.push(`${d.name}：失敗（${e.message.slice(0, 80)}）`); }
  }
  return { done: out, left: Math.max(0, (lib.sent || []).length - done.size - todo.length) };
}

/** Apps Script に「PDF にして送ってほしい Google スライド」を伝える */
export async function slidesNeeded(uid) {
  await ensure();
  const lib = await library();
  const { rows } = await pool.query(`SELECT ref, tries, error FROM deck_designs WHERE user_id = $1 AND ref LIKE 'slides:%'`, [uid]);
  const done = new Map(rows.map((r) => [r.ref, r]));
  return (lib.slides || []).map((s) => { const m = String(s.slide_url || '').match(/\/d\/([A-Za-z0-9_-]{20,})/); return m ? { file_id: m[1], ref: `slides:${m[1]}`, name: s.filename || '提案資料', company: s.company_name || '', day: s.day || '' } : null; })
    .filter((s) => s && (!done.get(s.ref) || (done.get(s.ref).error && done.get(s.ref).tries < 3))).slice(0, PER_RUN);
}
export async function saveSlidesPdf(uid, { file_id, name, company, day, pdf_base64, error }) {
  await ensure();
  const d = { ref: `slides:${String(file_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`, source: 'slides', name, company, day };
  if (error || !pdf_base64) { await markFailed(uid, d, error || 'PDF がありません'); return { ref: d.ref, error: error || 'PDF がありません' }; }
  try { return await saveDeck(uid, { ...d, pdf: Buffer.from(String(pdf_base64), 'base64') }); }
  catch (e) { await markFailed(uid, d, e.message); throw e; }
}

// ---- 読む側 ----
const fmtSizes = (s) => `見出し${s.title || '－'}pt・本文${s.body || '－'}pt`;
/** 1ページの見た目を、人も AI も読める1行にする */
export function pageLine(d) {
  if (!d) return '';
  const box = d.boxes.length ? `箱${d.boxes.length}つ（${[...new Set(d.boxes.map((b) => `${b.fill}${b.kind === 'round' ? '角丸' : b.kind === 'circle' ? '丸' : b.kind === 'oval' ? '楕円' : b.kind === 'shape' ? '図形' : ''}`))].slice(0, 3).join('・')}）` : '箱なし';
  const t = d.title ? `見出し「${d.title.t.slice(0, 20)}」${d.title.align}上${d.title.y}%・${d.title.size}pt${d.title.bold ? '太字' : ''}${d.title.color ? '・' + d.title.color : ''}` : '見出しなし';
  return `p${d.page} ${d.kind}／地 ${d.bg}${d.bgGradient ? '（グラデーション）' : ''}・余白${d.blank}%／${t}／本文${d.sizes.body}pt${d.textColors[0] ? '・' + d.textColors[0] : ''}／${box}／線${d.lines.length}本／画像${d.images.length}枚（${d.imageCover}%）／${d.layout.columns}段・${d.layout.chars}字`;
}
export function deckLine(s) {
  if (!s) return '';
  return `${s.aspect}・${s.pages}ページ／色：${s.colors.slice(0, 4).map((c) => `${c.hex}（${c.name}${c.share}%）`).join('・')}／メイン ${s.main || '－'}・差し色 ${s.accent || '－'}・文字 ${s.text[0] || '－'}／${s.bg}／字体：${s.fonts.join('・') || '不明'}／${fmtSizes(s.sizes)}／見出しは${s.titleAt.align ? `${s.titleAt.align}上${s.titleAt.y}%` : '－'}／左の余白${s.margin}%・1ページ${s.chars}字・空き${s.blank}%／箱 平均${s.boxes}つ${s.rounded ? '（角丸あり）' : ''}・画像のあるページ${s.images}`;
}

export async function listDecks(uid, limit = 40) {
  await ensure();
  const { rows } = await pool.query(`SELECT ref, source, name, company, day, pages, summary, error FROM deck_designs WHERE user_id = $1 ORDER BY day DESC NULLS LAST, updated_at DESC LIMIT $2`, [uid, limit]);
  return rows;
}
export async function deckPages(uid, ref) {
  await ensure();
  const { rows } = await pool.query(`SELECT page, design, text FROM deck_pages WHERE user_id = $1 AND ref = $2 ORDER BY page`, [uid, ref]);
  return rows;
}
export async function pageImage(uid, ref, page) {
  await ensure();
  const { rows } = await pool.query(`SELECT image FROM deck_pages WHERE user_id = $1 AND ref = $2 AND page = $3`, [uid, ref, page]);
  return rows[0]?.image || null;
}
/** kinbot の PDF の id とページから、見た目の1行を引く（提案資料ライブラリのベースに見た目を足すため） */
export async function designsFor(uid, keys) {
  await ensure();
  if (!keys.length) return new Map();
  const { rows } = await pool.query(`SELECT ref, page, design FROM deck_pages WHERE user_id = $1 AND (ref || '#' || page) = ANY($2::text[])`, [uid, keys]);
  return new Map(rows.map((r) => [`${r.ref}#${r.page}`, r.design]));
}

/** 「提案資料の見た目」ドキュメント（Gemini 用）と、提案資料ライブラリの「デザインの型」の節 */
export async function designDoc(uid, { withImages = false } = {}) {
  const decks = (await listDecks(uid, 30)).filter((d) => d.summary);
  const out = ['# kinbot 提案資料の見た目（自動・編集しない）', '',
    'kinbot にたまった提案資料（PDF・Google スライド）を、knowkin が1ページずつ絵にして数えた「見た目の部品」。AI は使っていない。',
    '新しい提案資料を作るときは、「1. みんなの型」の色・字体・文字の大きさ・見出しの位置・余白・箱の使い方に合わせ、ページの種類ごとの作りは「2」の例をまねる。色は #rrggbb、位置と大きさはページの左上からの割合（%）。', ''];
  if (!decks.length) { out.push('まだ見た目を数えた資料がない（1時間に3件ずつ増える）。'); return { text: out.join('\n'), images: [] }; }
  // 1. みんなの型：資料をまたいで多いもの
  const cnt = (f) => { const m = new Map(); for (const d of decks) for (const v of [].concat(f(d.summary)).filter(Boolean)) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const colorAll = new Map();
  for (const d of decks) for (const c of d.summary.colors || []) { const k = [...colorAll.keys()].find((x) => dist(rgbOf(x), rgbOf(c.hex)) < 30) || c.hex; colorAll.set(k, (colorAll.get(k) || 0) + 1); }
  out.push('## 1. みんなの型（資料をまたいで多いもの）', '',
    `- 形：${cnt((s) => s.aspect).slice(0, 2).map(([v, n]) => `${v}（${n}件）`).join('・')}`,
    `- よく使う色：${[...colorAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `${h}（${colorName(h)}・${n}件）`).join('・')}`,
    `- メインの色：${cnt((s) => s.main).slice(0, 3).map(([v, n]) => `${v}（${colorName(v)}・${n}件）`).join('・') || '－'}`,
    `- 差し色：${cnt((s) => s.accent).slice(0, 3).map(([v, n]) => `${v}（${colorName(v)}・${n}件）`).join('・') || '－'}`,
    `- 文字の色：${cnt((s) => s.text[0]).slice(0, 2).map(([v, n]) => `${v}（${n}件）`).join('・') || '－'}`,
    `- 字体：${cnt((s) => s.fonts).slice(0, 4).map(([v, n]) => `${v}（${n}件）`).join('・') || '不明（PDF に名前が入っていない）'}`,
    `- 文字の大きさ（中央値）：見出し${Math.round(median(decks.map((d) => d.summary.sizes.title).filter(Boolean)))}pt・本文${Math.round(median(decks.map((d) => d.summary.sizes.body).filter(Boolean)))}pt`,
    `- 見出しの位置（表紙以外）：${cnt((s) => s.titleAt.align).slice(0, 2).map(([v, n]) => `${v}寄せ（${n}件）`).join('・') || 'まだ数えられない'}${decks.some((d) => d.summary.titleAt.align) ? `・上から${Math.round(median(decks.filter((d) => d.summary.titleAt.align).map((d) => d.summary.titleAt.y)))}%あたり` : ''}`,
    `- 余白：左${Math.round(median(decks.map((d) => d.summary.margin)))}%・1ページの文字${Math.round(median(decks.map((d) => d.summary.chars)))}字・何もない所${Math.round(median(decks.map((d) => d.summary.blank)))}%`,
    `- 箱（カード）：1ページ平均${Math.round(median(decks.map((d) => d.summary.boxes)) * 10) / 10}つ・角丸の資料${decks.filter((d) => d.summary.rounded).length}/${decks.length}件`,
    `- ページの種類の数（全資料）：${cnt((s) => s.flow).map(([v, n]) => `${v}${n}`).join('・')}`, '');
  // 2. ページの種類ごとの例（いちばん新しい資料から1ページずつ）
  const { rows: ex } = await pool.query(`SELECT DISTINCT ON (p.design->>'kind') p.ref, p.page, p.design, d.name FROM deck_pages p JOIN deck_designs d ON d.user_id = p.user_id AND d.ref = p.ref
     WHERE p.user_id = $1 ORDER BY p.design->>'kind', d.day DESC NULLS LAST, p.page`, [uid]);
  const images = [];
  out.push('## 2. ページの種類ごとの作り（例）', '');
  for (const e of ex) {
    const d = e.design;
    out.push(`### ${d.kind}（${e.name} p${e.page}）`, pageLine(d));
    if (d.boxes.length) out.push(`- 箱の置き方：${d.boxes.slice(0, 6).map((b) => `左${b.x}%・上${b.y}%・幅${b.w}%・高さ${b.h}%・${b.fill}`).join('／')}`);
    if (d.texts.length) out.push(`- 文字の置き方：${d.texts.slice(0, 6).map((t) => `「${t.t.slice(0, 16)}」左${t.x}%上${t.y}%・${t.size}pt${t.bold ? '太' : ''}${t.color ? '・' + t.color : ''}`).join('／')}`);
    if (withImages) { out.push(`[[絵:${e.ref}#${e.page}]]`); images.push({ ref: e.ref, page: e.page }); }
    out.push('');
  }
  // 3. 資料ごと
  out.push('## 3. 資料ごとの型（新しい順）', '');
  for (const d of decks.slice(0, 20)) {
    out.push(`### ${d.name}（${d.day || ''}・${d.company || '送り先なし'}・${d.source === 'slides' ? 'Google スライド' : 'PDF'}）`, deckLine(d.summary),
      `- ページの流れ：${(d.summary.flow || []).join('→')}`,
      `- 部品を JSON で：${JSON.stringify({ colors: { main: d.summary.main, accent: d.summary.accent, text: d.summary.text[0] || null, bg: d.summary.bgColors[0] || null }, fonts: d.summary.fonts, size: d.summary.sizes, aspect: d.summary.aspect })}`);
    if (withImages && d.summary.cover) { out.push(`[[絵:${d.ref}#1]]`); images.push({ ref: d.ref, page: 1 }); }
    out.push('');
  }
  const seen = new Set();
  return { text: out.join('\n'), images: images.filter((i) => { const k = `${i.ref}#${i.page}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}
