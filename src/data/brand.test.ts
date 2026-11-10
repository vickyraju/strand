import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRAND_DEFAULT, brandReadable, brandShades, contrast } from '../../server/src/shared/brand.ts'

test('[0702.R4] contrast follows WCAG: black on white is 21, a colour on itself 1', () => {
  assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21)
  assert.equal(contrast('#368727', '#368727'), 1)
})

test('[0702.R4] a brand colour must carry white text: Strand’s green and a dark blue pass; yellow and malformed fail', () => {
  assert.equal(brandReadable(BRAND_DEFAULT), true)
  assert.equal(brandReadable('#1D4ED8'), true)
  assert.equal(brandReadable('#FACC15'), false)
  assert.equal(brandReadable('red'), false)
})

test('[0702.R4] the shades: darker for hover and pressed, a pale soft background, lighter in the dark theme', () => {
  const s = brandShades('#1D4ED8')
  assert.ok(contrast(s.light.press, '#FFFFFF') > contrast(s.light.brand, '#FFFFFF'))
  assert.ok(contrast(s.light.soft, '#FFFFFF') < 1.3)
  assert.ok(contrast(s.dark.brand, '#000000') > contrast('#1D4ED8', '#000000'))
})
