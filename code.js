// HTML Import — main thread.
// The UI iframe renders the HTML, measures every element and sends a plain tree of
// frames / text / images / svgs here, with absolute page coordinates. This file turns
// that tree into Figma nodes.

figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'import') {
    try {
      const summary = await runImport(msg);
      figma.ui.postMessage(Object.assign({ type: 'done' }, summary));
    } catch (err) {
      console.error(err);
      figma.ui.postMessage({ type: 'error', message: (err && err.message) || String(err) });
    }
  } else if (msg.type === 'notify') {
    figma.notify(msg.text);
  }
};

function progress(text, frac) {
  figma.ui.postMessage({ type: 'progress', text: text, frac: frac });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Import

async function runImport(msg) {
  const pages = msg.pages;
  const options = msg.options || {};
  const ctx = { hashes: {}, svgs: {}, count: 0, total: 0, failedImages: 0 };

  for (const p of pages) ctx.total += countNodes(p.root);

  progress('Loading fonts…', 0);
  await prepareFonts(pages);

  progress('Creating images…', 0);
  await createImages(msg.images || {}, ctx);

  let page = figma.currentPage;
  if (options.newPage) {
    page = figma.createPage();
    page.name = options.pageName || 'HTML Import';
    await figma.setCurrentPageAsync(page);
  }

  let x = 0;
  if (!options.newPage) {
    for (const child of page.children) x = Math.max(x, child.x + child.width + 200);
  }

  const roots = [];
  for (const p of pages) {
    const root = await build(p.root, page, 0, 0, ctx);
    if (!root) continue;
    root.name = p.name;
    root.x = x;
    root.y = 0;
    x += root.width + 160;
    roots.push(root);
  }

  page.selection = roots;
  figma.viewport.scrollAndZoomIntoView(roots);
  figma.notify('Imported ' + roots.length + ' frame' + (roots.length === 1 ? '' : 's'));

  return {
    frames: roots.length,
    nodes: ctx.count,
    missingFonts: Array.from(missingFonts),
    failedImages: ctx.failedImages,
  };
}

function countNodes(n) {
  let c = 1;
  if (n.children) for (const child of n.children) c += countNodes(child);
  return c;
}

// ---------------------------------------------------------------------------
// Node building. Every node in the tree carries absolute coordinates (x, y, w, h);
// children are positioned relative to their parent's absolute origin (px, py).

async function build(n, parent, px, py, ctx) {
  ctx.count++;
  if (ctx.count % 150 === 0) {
    progress('Building layers… ' + ctx.count + ' / ' + ctx.total, ctx.count / ctx.total);
    await tick();
  }

  let node = null;
  try {
    if (n.type === 'text') node = makeText(n);
    else if (n.type === 'svg') node = makeSvg(n.svg, n, ctx, n.fallback);
    else if (n.type === 'rect') node = makeRect(n, ctx);
    else node = makeFrame(n, ctx);
  } catch (err) {
    console.warn('Skipped node', n.name, err);
    return null;
  }
  if (!node) return null;

  parent.appendChild(node);

  let ax = n.x;
  if (n.type === 'text') {
    if (n.auto && n.anchor === 'CENTER') ax = n.x + n.w / 2 - node.width / 2;
    else if (n.auto && n.anchor === 'RIGHT') ax = n.x + n.w - node.width;
    node.x = ax - px;
    node.y = n.y - py;
  } else {
    // Vectors are scaled to fit (contain) — centre them in their box.
    node.x = n.x + (n.w - node.width) / 2 - px;
    node.y = n.y + (n.h - node.height) / 2 - py;
  }

  if (n.type === 'frame' && n.children) {
    const kids = [];
    for (const child of n.children) {
      const k = await build(child, node, n.x, n.y, ctx);
      if (k) kids.push({ node: k, n: child });
    }
    if (n.al) applyLayout(node, n, kids);
  }
  return node;
}

// Turn a frame into auto layout. The UI has already worked out direction, padding,
// spacing and alignment so that Figma's layout reproduces the captured positions.
function applyLayout(f, n, kids) {
  const al = n.al;
  const pinned = kids.filter((k) => k.n.abs).map((k) => ({ node: k.node, x: k.node.x, y: k.node.y }));
  try {
    f.layoutMode = al.dir === 'V' ? 'VERTICAL' : 'HORIZONTAL';
    if (al.wrap) {
      f.layoutWrap = 'WRAP';
      f.counterAxisSpacing = al.cgap;
    }
    f.paddingTop = al.pad[0];
    f.paddingRight = al.pad[1];
    f.paddingBottom = al.pad[2];
    f.paddingLeft = al.pad[3];
    f.itemSpacing = al.gap;
    f.primaryAxisAlignItems = al.main;
    f.counterAxisAlignItems = al.cross;
  } catch (err) {
    console.warn('Auto layout failed on', n.name, err);
  }
  for (const k of kids) {
    const lay = k.n.lay || {};
    try {
      if (k.n.abs) k.node.layoutPositioning = 'ABSOLUTE';
      if (lay.stretch) k.node.layoutAlign = 'STRETCH';
      if (lay.grow) k.node.layoutGrow = 1;
      if (lay.maxW) k.node.maxWidth = lay.maxW;
    } catch (err) {
      // property not supported on this node type / API version
    }
  }
  for (const p of pinned) {
    p.node.x = p.x;
    p.node.y = p.y;
  }
  try {
    f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    f.primaryAxisSizingMode = al.hugMain ? 'AUTO' : 'FIXED';
    f.counterAxisSizingMode = al.hugCross ? 'AUTO' : 'FIXED';
  } catch (err) {
    console.warn('Auto layout sizing failed on', n.name, err);
  }
}

function makeFrame(n, ctx) {
  const f = figma.createFrame();
  f.name = n.name || 'div';
  f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  f.fills = paints(n.fills, ctx);
  f.clipsContent = !!n.clip;
  applyBox(f, n);
  return f;
}

function makeRect(n, ctx) {
  // <img> pointing at an SVG with no box decoration: import it as editable vectors.
  if (n.isImg && n.imageId && ctx.svgs[n.imageId] && !n.stroke && !n.effects && !hasRadius(n.radius) && n.fills.length === 1) {
    const vec = makeSvg(ctx.svgs[n.imageId], n, ctx, n.imageId);
    if (vec) return vec;
  }
  const r = figma.createRectangle();
  r.name = n.name || 'Rectangle';
  r.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  const fills = paints(n.fills, ctx);
  if (n.isImg && !fills.some((p) => p.type === 'IMAGE')) {
    fills.push(solid({ r: 0.88, g: 0.88, b: 0.88, a: 1 }));
    r.name += ' (image missing)';
  }
  r.fills = fills;
  applyBox(r, n);
  return r;
}

function makeSvg(markup, n, ctx, fallbackId) {
  let node = null;
  try {
    node = figma.createNodeFromSvg(markup);
  } catch (err) {
    node = null;
  }
  if (!node) {
    const hash = fallbackId && ctx.hashes[fallbackId];
    const r = figma.createRectangle();
    r.name = n.name || 'svg';
    r.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    r.fills = hash
      ? [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FIT' }]
      : [solid({ r: 0.88, g: 0.88, b: 0.88, a: 1 })];
    return r;
  }
  node.name = n.name || 'svg';
  if (node.width > 0 && node.height > 0 && n.w > 0 && n.h > 0) {
    const k = Math.min(n.w / node.width, n.h / node.height);
    if (isFinite(k) && k > 0 && Math.abs(k - 1) > 0.01) node.rescale(k);
  }
  if (n.opacity != null) node.opacity = n.opacity;
  return node;
}

function makeText(n) {
  const spans = n.spans;
  if (!spans || !spans.length) return null;
  const t = figma.createText();
  t.fontName = fontFor(spans[0]);
  t.characters = spans.map((s) => s.text).join('');

  let i = 0;
  for (const s of spans) {
    const a = i;
    const b = i + s.text.length;
    i = b;
    if (b <= a) continue;
    t.setRangeFontName(a, b, fontFor(s));
    t.setRangeFontSize(a, b, Math.max(1, s.size));
    t.setRangeFills(a, b, [solid(s.color)]);
    t.setRangeLineHeight(a, b, s.lh > 0 ? { unit: 'PIXELS', value: s.lh } : { unit: 'AUTO' });
    if (s.ls) t.setRangeLetterSpacing(a, b, { unit: 'PIXELS', value: s.ls });
    if (s.deco && s.deco !== 'NONE') t.setRangeTextDecoration(a, b, s.deco);
    if (s.tcase && s.tcase !== 'ORIGINAL') t.setRangeTextCase(a, b, s.tcase);
  }

  t.textAlignHorizontal = n.auto && n.align === 'JUSTIFIED' ? 'LEFT' : n.align || 'LEFT';
  if (n.auto) {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    // 1px of slack so Figma's slightly different text metrics don't force an extra wrap.
    t.resize(Math.max(1, n.w + 1), Math.max(1, n.h));
    t.textAutoResize = 'HEIGHT';
  }
  if (n.opacity != null) t.opacity = n.opacity;
  return t;
}

function applyBox(node, n) {
  if (n.stroke) {
    const w = n.stroke.weights;
    node.strokes = [n.stroke.paint];
    node.strokeAlign = 'INSIDE';
    if (w[0] === w[1] && w[1] === w[2] && w[2] === w[3]) {
      node.strokeWeight = w[0];
    } else {
      node.strokeTopWeight = w[0];
      node.strokeRightWeight = w[1];
      node.strokeBottomWeight = w[2];
      node.strokeLeftWeight = w[3];
    }
    const max = Math.max(w[0], w[1], w[2], w[3]);
    if (n.stroke.dash === 'dashed') node.dashPattern = [max * 3, max * 2];
    else if (n.stroke.dash === 'dotted') node.dashPattern = [max, max];
  }
  if (hasRadius(n.radius)) {
    const r = n.radius;
    if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) {
      node.cornerRadius = r[0];
    } else {
      node.topLeftRadius = r[0];
      node.topRightRadius = r[1];
      node.bottomRightRadius = r[2];
      node.bottomLeftRadius = r[3];
    }
  }
  if (n.effects && n.effects.length) setEffects(node, n.effects);
  if (n.opacity != null) node.opacity = n.opacity;
  if (n.blend) {
    try {
      node.blendMode = n.blend;
    } catch (err) {
      // CSS blend mode with no Figma equivalent
    }
  }
}

function hasRadius(r) {
  return !!r && (r[0] > 0 || r[1] > 0 || r[2] > 0 || r[3] > 0);
}

function setEffects(node, effects) {
  // Blur effects gained a `blurType` field in newer API versions; try both shapes.
  const attempts = [
    effects,
    effects.map((e) => (/BLUR/.test(e.type) ? Object.assign({ blurType: 'NORMAL' }, e) : e)),
    effects.filter((e) => !/BLUR/.test(e.type)),
  ];
  for (const list of attempts) {
    try {
      node.effects = list;
      return;
    } catch (err) {
      // try next shape
    }
  }
}

function solid(c) {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

function paints(list, ctx) {
  const out = [];
  for (const p of list || []) {
    if (p.type === 'IMAGE') {
      const hash = ctx.hashes[p.imageId];
      if (hash) out.push({ type: 'IMAGE', imageHash: hash, scaleMode: p.scaleMode || 'FILL' });
    } else {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Images

async function createImages(images, ctx) {
  const ids = Object.keys(images);
  let done = 0;
  for (const id of ids) {
    const im = images[id];
    try {
      if (im.bytes) ctx.hashes[id] = figma.createImage(im.bytes).hash;
      else if (im.url) ctx.hashes[id] = (await figma.createImageAsync(im.url)).hash;
      else ctx.failedImages++;
    } catch (err) {
      ctx.failedImages++;
    }
    if (im.svg) ctx.svgs[id] = im.svg;
    done++;
    if (done % 10 === 0) {
      progress('Creating images… ' + done + ' / ' + ids.length, done / ids.length);
      await tick();
    }
  }
}

// ---------------------------------------------------------------------------
// Fonts. CSS font stacks are matched against the fonts Figma can see; anything
// unavailable falls back down the stack and finally to Inter.

const GENERIC = {
  'sans-serif': ['Inter', 'Roboto', 'Arial', 'Helvetica'],
  'ui-sans-serif': ['Inter', 'Roboto', 'Arial', 'Helvetica'],
  'system-ui': ['SF Pro Text', 'SF Pro', 'Inter', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'SF Pro', 'Inter', 'Roboto'],
  blinkmacsystemfont: ['SF Pro Text', 'SF Pro', 'Inter', 'Roboto'],
  serif: ['Times New Roman', 'Georgia', 'Noto Serif', 'Source Serif Pro'],
  'ui-serif': ['Georgia', 'Times New Roman', 'Noto Serif'],
  monospace: ['Roboto Mono', 'SF Mono', 'Menlo', 'Courier New', 'Source Code Pro'],
  'ui-monospace': ['SF Mono', 'Roboto Mono', 'Menlo', 'Courier New'],
  cursive: ['Comic Sans MS', 'Inter'],
  fantasy: ['Impact', 'Inter'],
  'apple color emoji': [],
  'segoe ui emoji': [],
  'segoe ui symbol': [],
  'noto color emoji': [],
};

let fontIndex = null;
const resolvedFonts = new Map();
const missingFonts = new Set();

async function prepareFonts(pages) {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const key = f.fontName.family.toLowerCase();
      if (!fontIndex.has(key)) fontIndex.set(key, []);
      fontIndex.get(key).push(f.fontName);
    }
  }
  missingFonts.clear();

  const wanted = new Map();
  const visit = (n) => {
    if (n.type === 'text') for (const s of n.spans) wanted.set(fontKey(s), s);
    if (n.children) n.children.forEach(visit);
  };
  pages.forEach((p) => visit(p.root));

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const unique = new Map();
  for (const s of wanted.values()) {
    const f = resolveFont(s.family, s.weight, s.italic);
    unique.set(f.family + '\u0000' + f.style, f);
  }
  await Promise.all(
    Array.from(unique.values()).map((f) =>
      figma.loadFontAsync(f).catch(() => {
        // Listed but not loadable — reroute everything that resolved to it.
        for (const [k, v] of resolvedFonts) {
          if (v.family === f.family && v.style === f.style) resolvedFonts.set(k, { family: 'Inter', style: 'Regular' });
        }
        missingFonts.add(f.family + ' ' + f.style);
      })
    )
  );
}

function fontKey(s) {
  return s.family + '|' + s.weight + '|' + s.italic;
}

function fontFor(s) {
  return resolvedFonts.get(fontKey(s)) || { family: 'Inter', style: 'Regular' };
}

function resolveFont(css, weight, italic) {
  const key = css + '|' + weight + '|' + italic;
  if (resolvedFonts.has(key)) return resolvedFonts.get(key);
  const families = splitFamilies(css);
  let out = null;
  for (let i = 0; i < families.length && !out; i++) {
    const fam = families[i];
    const generic = GENERIC[fam.toLowerCase()];
    for (const candidate of generic || [fam]) {
      const list = fontIndex.get(candidate.toLowerCase());
      if (list) {
        out = pickStyle(list, weight, italic);
        break;
      }
    }
    if (!out && i === 0 && !generic) missingFonts.add(fam);
  }
  if (!out) out = pickStyle(fontIndex.get('inter') || [{ family: 'Inter', style: 'Regular' }], weight, italic);
  resolvedFonts.set(key, out);
  return out;
}

function splitFamilies(css) {
  return String(css || '')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function pickStyle(list, weight, italic) {
  let best = list[0];
  let bestScore = Infinity;
  for (const f of list) {
    let score = Math.abs(styleWeight(f.style) - weight);
    if (/italic|oblique/i.test(f.style) !== italic) score += 1000;
    if (/condensed|narrow|expanded|extended|wide|display|caption|subhead|text$|mono/i.test(f.style)) score += 50;
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function styleWeight(style) {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  const num = s.match(/\d{3}/);
  if (num) return +num[0];
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  return 400;
}
