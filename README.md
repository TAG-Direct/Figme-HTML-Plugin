# HTML Import — Figma plugin

Turns an HTML file, a ZIP of a site, or a folder into editable Figma frames, with one frame per page per viewport width.

## Install (Figma desktop app)

1. **Plugins → Development → Import plugin from manifest…**
2. Pick `manifest.json` in this folder.
3. Run it from **Plugins → Development → HTML Import**.

There's no build step. `code.js` and `ui.html` are loaded as they are.

## Use

- Drop in a `.html` file, a `.zip`, or choose a folder. If the ZIP or folder contains several HTML files, tick the ones you want.
- Pick one or more viewport widths (e.g. 1440 and 390). Each page × width becomes its own frame, laid out side by side.
- **Use auto layout.** Frames become auto layout wherever their children form a row, a column or a wrapping row. See [Auto layout](#auto-layout) below.
- **Run the page's JavaScript.** Needed for JS-rendered pages (React builds, Tailwind CDN, etc.). Turn it off for static HTML.
- **Flatten unstyled wrapper elements.** Drops `div`s that have no fill, border, shadow or clipping, so the layer tree isn't 20 levels deep. Landmarks (`header`, `nav`, `section`, `footer`…), buttons, forms, and anything with an `id` are kept. With auto layout on, only single-child wrappers are dropped; a wrapper that groups several items is kept as its own row or column.
- **Wait after load.** Extra time for scripts to finish rendering before capture.

A single `.html` file can't resolve relative assets such as `img/logo.png` or `css/site.css`. Use a ZIP or folder for those. Absolute URLs (CDNs, Google Fonts, remote images) work either way.

## How it works

1. **UI (`ui.html`)** unzips in the browser using `DecompressionStream`, with no dependencies. It inlines local CSS, images, fonts and scripts as data URLs, then renders the page in a hidden `<iframe>` at the chosen width. Animations and transitions are frozen at their end state, and the page is scrolled through once so scroll-triggered content appears.
2. It walks the rendered DOM using `getComputedStyle` and `getBoundingClientRect` and builds a tree of frames, text, images and SVGs with absolute coordinates. It also fetches every image as bytes.
3. **Main (`code.js`)** creates the Figma nodes, matches CSS font stacks to fonts Figma has installed, and places each frame on a new page (or to the right of existing content).

## Auto layout

The plugin works out the auto layout from where the browser actually drew things, so the Figma result matches the render. The CSS is only used to break ties.

| In the browser | In Figma |
|---|---|
| Flexbox row/column, block flow | Horizontal/vertical auto layout, with gap → spacing and border + padding → padding |
| `justify-content` center / end / space-between | Primary-axis alignment |
| `align-items`, centred children | Counter-axis alignment |
| `align-items: stretch`, full-width blocks, text in block flow | Fill container |
| `flex-grow` | Fill container (main axis), when the items end up equal sizes |
| `max-width` + `margin: auto` containers | Fill container with a max width, centred |
| `flex-wrap`, CSS grid with several rows | Wrapping auto layout (horizontal + vertical gap) |
| Badges, inline-block buttons | Hug contents |
| `position: absolute / fixed` | Absolute position inside the auto layout frame |
| Uneven margins between siblings | Folded into a neighbouring transparent frame's padding, or else a transparent `margin` wrapper frame |

A frame keeps absolute positioning (no auto layout) when its children overlap or overflow it: floats with wrapping text, carousels, negative margins, and content that's too wide for its box. Text renders slightly differently in Figma, so a hugging frame can come out a pixel or two off.

## What comes across

- Background colours, linear, radial and conic gradients, background images (cover/contain/tile), and multiple background layers
- Borders (including per-side widths and dashed/dotted), per-corner radii, box shadows (drop and inset), `filter: blur`, `backdrop-filter: blur`, opacity, blend modes, and overflow clipping
- Text as real text layers: mixed bold/italic/link/colour runs stay in one layer, with font, size, weight, line height, letter spacing, alignment, underline/strike-through and text-transform
- `<img>` as image fills (SVG images become editable vectors), inline `<svg>` as vectors (with CSS classes and `currentColor` baked in), `<canvas>`, video posters
- Form controls (inputs with value or placeholder, selects, checkboxes, radios), and list bullets and numbers
- Modern colour syntax (`oklch()`, `color()`, …), web components (shadow DOM), and `display: contents`

## Known limits

- **Fonts must be installed** for Figma to use them. Missing fonts fall back down the CSS stack and then to Inter, and the plugin lists any it substituted.
- `::before` / `::after` pseudo-elements aren't captured, so decorative shapes and icon-font glyphs drawn that way are missing.
- Rotated or skewed elements come in as their unrotated bounding box. `clip-path`, masks and `text-shadow` are ignored.
- Scroll containers (an inner `overflow: auto` panel) are captured as their visible part only.
- Remote images on servers that block cross-origin requests are retried through Figma. If that also fails, you get a grey placeholder.
- JS module scripts that `import` other local files from the ZIP won't resolve. Pre-built bundles are fine.
