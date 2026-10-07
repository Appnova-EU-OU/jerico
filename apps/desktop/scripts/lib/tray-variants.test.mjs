import test from 'node:test'
import assert from 'node:assert/strict'
import { VARIANTS, buildDocument } from './tray-variants.mjs'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>'
const byName = (name) => VARIANTS.find((v) => v.name === name)

test('VARIANTS: exactly three variants, in order', () => {
  assert.deepEqual(VARIANTS.map((v) => v.name), ['quiet', 'attention', 'down'])
})

test('VARIANTS: quiet carries no badge', () => {
  assert.equal(byName('quiet').badge, null)
})

test('VARIANTS: attention is a hollow ring, down is a filled disc', () => {
  assert.equal(byName('attention').badge, 'ring')
  assert.equal(byName('down').badge, 'disc')
})

test('VARIANTS: only down is dimmed, at 58%', () => {
  for (const v of VARIANTS) {
    assert.equal(v.inkAlpha, v.name === 'down' ? 0.58 : 1, v.name)
  }
})

test('VARIANTS: no variant carries an ink colour — template images are always black', () => {
  for (const v of VARIANTS) assert.equal(v.ink, undefined, v.name)
})

test('buildDocument: no variant emits a chromatic colour', () => {
  for (const v of VARIANTS) {
    const html = buildDocument(SVG, v, 44)
    assert.ok(!/#(?!000000\b)[0-9a-fA-F]{6}\b/.test(html), `${v.name} emitted a non-black hex colour`)
  }
})

test('buildDocument: sizes the page to the target box', () => {
  const html = buildDocument(SVG, byName('quiet'), 44)
  assert.match(html, /width:\s*44px/)
  assert.match(html, /height:\s*44px/)
})

test('buildDocument: ground is transparent', () => {
  assert.match(buildDocument(SVG, byName('quiet'), 22), /background:\s*transparent/)
})

test('buildDocument: inlines the svg and inks it pure black', () => {
  const html = buildDocument(SVG, byName('attention'), 44)
  assert.ok(html.includes('<circle cx="12" cy="12" r="4"/>'))
  assert.match(html, /color:\s*#000000/)
})

test('buildDocument: dimming is expressed as opacity on the glyph only', () => {
  const html = buildDocument(SVG, byName('down'), 44)
  assert.match(html, /opacity:\s*0\.58/)
})

test('buildDocument: quiet emits no badge and no mask', () => {
  const html = buildDocument(SVG, byName('quiet'), 44)
  assert.ok(!html.includes('id="badge"'))
  assert.ok(!html.includes('-webkit-mask-image'))
})

test('buildDocument: badged variants mask a hole in the glyph', () => {
  for (const name of ['attention', 'down']) {
    const html = buildDocument(SVG, byName(name), 44)
    assert.ok(html.includes('id="badge"'), name)
    assert.match(html, /-webkit-mask-image:\s*radial-gradient/)
  }
})

test('buildDocument: the ring is stroked and hollow, the disc is filled', () => {
  const ring = buildDocument(SVG, byName('attention'), 44)
  assert.match(ring, /border:\s*3px solid currentColor/)
  assert.match(ring, /background:\s*transparent/)

  const disc = buildDocument(SVG, byName('down'), 44)
  assert.match(disc, /#badge\s*\{[^}]*background:\s*currentColor/)
  assert.ok(!/#badge\s*\{[^}]*border:/.test(disc))
})

test('buildDocument: the badge is never dimmed with the glyph', () => {
  const html = buildDocument(SVG, byName('down'), 44)
  const badgeBlock = html.match(/#badge\s*\{[^}]*\}/)[0]
  assert.ok(!badgeBlock.includes('opacity'))
})

test('buildDocument: geometry scales with the box — glyph and badge double from 22 to 44', () => {
  assert.match(buildDocument(SVG, byName('attention'), 22), /--glyph:\s*16px/)
  assert.match(buildDocument(SVG, byName('attention'), 44), /--glyph:\s*32px/)
  assert.match(buildDocument(SVG, byName('attention'), 22), /--badge:\s*6px/)
  assert.match(buildDocument(SVG, byName('attention'), 44), /--badge:\s*12px/)
})

test('buildDocument: rejects a size that is not 22 or 44', () => {
  assert.throws(() => buildDocument(SVG, byName('quiet'), 30), /unsupported size/)
})
