# Tray mark

`mark.svg` is the menu-bar mark: one node fanning out to three.

Extracted verbatim from `../../design/01-tray-popover.html` §"Quiet when healthy"
(rev D, approved). That page is the design authority — if the mark changes there,
change it here too, and re-render.

## Renderings

Per `docs/superpowers/specs/2026-08-07-tray-icon-states-design.md` D1/D2:

| Tray state | Rendering | Image kind | Glyph | Badge |
|---|---|---|---|---|
| `green` | quiet | template | macOS derives the color | none |
| `yellow` | attention | template | full-strength ink | hollow ring |
| `red` | down | template | ink at 58% alpha | filled disc |

Healthy is the quiet case. A badge in the menu bar means something is wrong.

Every rendering is a template image: macOS masks it to its alpha and derives the
drawing colour from the menu bar itself, so one asset per state covers both menu
bar appearances. State is carried by the badge's shape, not by colour.

## Deviation from the approved design

`../../design/01-tray-popover.html` §"Quiet when healthy" specifies a colour flag on a
non-template composite for the flagged states. That was built first and failed a live
menu bar test on 2026-08-07:

- A non-template image does not auto-invert, so it needs one variant per menu bar
  appearance, selected from `nativeTheme.shouldUseDarkColors`.
- That property reports the **system appearance**. macOS switches the menu bar to
  light-on-dark from the **desktop picture's luminance**, independently.
- Light appearance + dark wallpaper — the default on the developer's machine — put a
  near-black glyph on a dark menu bar while the system menu text was white.

Template images have no such failure mode. So the design's rule "colour in the menu bar
means something is wrong" is implemented here as *shape* in the menu bar means something
is wrong; quiet-when-healthy is unchanged.

**`01-tray-popover.html` still shows the composite approach and needs a matching edit.**

## Re-rendering

```bash
cd apps/desktop
npx electron scripts/render-tray-icons.mjs
```

Writes `src/main/tray-icons.generated.ts`. Run it by hand and commit the output —
it is deliberately not part of `pnpm build`.
