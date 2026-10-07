// Variant table and HTML construction for the menu bar mark.
// Pure: no Electron, no filesystem — the renderer in ../render-tray-icons.mjs
// supplies the SVG text and turns these documents into pixels.
//
// EVERY variant is a macOS template image: macOS masks it to its alpha and
// derives the drawing colour from the menu bar it is actually drawing into.
// That is why nothing here carries an ink colour, and why state is carried by
// the badge's SHAPE rather than by colour. See
// docs/superpowers/specs/2026-08-07-tray-icon-states-design.md D1/D2 — a
// non-template colour flag was built first and failed live, because
// nativeTheme.shouldUseDarkColors tracks the system appearance while macOS
// tints the menu bar from the desktop picture.

const DIM_ALPHA = 0.58 // 'down' glyph — the design's #8e8a83 over a dark menu bar

/**
 * Three variants. `down` is separated from `attention` twice over: a dimmed
 * glyph and a solid badge, so it survives the badge being hard to read at 22pt.
 */
export const VARIANTS = Object.freeze([
  { name: 'quiet',     inkAlpha: 1,         badge: null },
  { name: 'attention', inkAlpha: 1,         badge: 'ring' },
  { name: 'down',      inkAlpha: DIM_ALPHA, badge: 'disc' },
].map(Object.freeze))

// Geometry as a fraction of the box side, so 22 and 44 stay proportional.
const GLYPH_RATIO = 16 / 22    // glyph box inside the 22pt menu bar box
const BADGE_RATIO = 6 / 22     // badge box
const KNOCKOUT_RATIO = 10 / 22 // hole diameter: the badge plus a 2px gap all round
const RING_STROKE_RATIO = 0.27 // of the badge box

/**
 * A complete HTML document rendering one variant at size x size CSS pixels on a
 * transparent ground.
 *
 * The badge's separation from the glyph is a real hole MASKED OUT of the glyph.
 * A template image has no ground colour to paint a ring in — only alpha — and
 * CSS has no Porter-Duff compositing (`mix-blend-mode` takes blend modes only),
 * so the hole is a radial-gradient mask. The badge is a sibling on top: unmasked,
 * and never dimmed with the glyph.
 */
export function buildDocument(svg, variant, size) {
  if (size !== 22 && size !== 44) throw new Error(`unsupported size: ${size}`)

  const glyph = Math.round(size * GLYPH_RATIO)
  const badge = Math.round(size * BADGE_RATIO)
  const knockout = Math.round(size * KNOCKOUT_RATIO)
  const ringStroke = Math.round(badge * RING_STROKE_RATIO)

  // The badge sits flush in the bottom-right corner, so its centre — and the
  // centre of the hole — is half a badge in from each edge of the box.
  const mask = variant.badge
    ? `-webkit-mask-image: radial-gradient(circle at calc(100% - ${badge / 2}px) calc(100% - ${badge / 2}px),` +
      ` transparent ${knockout / 2}px, #000 ${knockout / 2}px);`
    : ''

  const badgeFill = variant.badge === 'ring'
    ? `border: ${ringStroke}px solid currentColor; background: transparent;`
    : 'background: currentColor;'

  const badgeMarkup = variant.badge ? '<div id="badge"></div>' : ''
  const badgeRule = variant.badge
    ? `
  #badge {
    position: absolute;
    right: 0; bottom: 0;
    width: var(--badge); height: var(--badge);
    box-sizing: border-box;
    border-radius: 50%;
    ${badgeFill}
  }`
    : ''

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --glyph: ${glyph}px; --badge: ${badge}px; }
  html, body {
    margin: 0; padding: 0;
    width: ${size}px; height: ${size}px;
    background: transparent;
  }
  #box {
    position: relative;
    width: ${size}px; height: ${size}px;
    color: #000000;
  }
  /* #glyph is a full-box layer, not a glyph-sized one: the mask's percentages
     resolve against the element it is applied to, so the hole only lands in the
     bottom-right corner of the ICON if this layer is the size of the icon. */
  #glyph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: ${variant.inkAlpha};
    ${mask}
  }
  /* The artwork is not centred in its own viewBox (content spans x 1-17, y 3-21),
     so nudge it to the optical centre of the box. */
  #glyph svg {
    display: block;
    width: var(--glyph); height: var(--glyph);
    transform: translateX(calc(var(--glyph) * -0.0417));
  }${badgeRule}
</style></head>
<body><div id="box"><div id="glyph">${svg}</div>${badgeMarkup}</div></body></html>`
}
