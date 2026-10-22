import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildNotices, collectPackages } from './notices.ts'

const root = new URL('..', import.meta.url).pathname

test('every runtime dependency, and what it depends on, has a notice with its licence text', () => {
  const direct = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies)
  const pkgs = collectPackages(root)
  for (const name of [...direct, '@xyflow/system', '@dagrejs/graphlib']) assert.ok(pkgs.some(p => p.name === name), `${name} is missing`)
  const text = buildNotices(root)
  for (const p of pkgs) assert.ok(text.includes(`${p.name} ${p.version}`), `${p.name} not listed`)
  assert.match(text, /Permission is hereby granted, free of charge/)                    // the MIT text itself is there
  assert.ok(pkgs.every(p => p.license !== 'UNKNOWN'), 'every package declares a licence')
})

test('build tools are not listed: they do not ship in the bundle', () => {
  const names = collectPackages(root).map(p => p.name)
  for (const tool of ['vite', 'typescript', 'tailwindcss']) assert.ok(!names.includes(tool), tool)
})

test('the list is sorted and has no duplicates', () => {
  const keys = collectPackages(root).map(p => `${p.name}@${p.version}`)
  assert.deepEqual(keys, [...new Set(keys)])
  assert.deepEqual(keys.map(k => k.split('@').slice(0, -1).join('@')), [...keys.map(k => k.split('@').slice(0, -1).join('@'))].sort((a, b) => a.localeCompare(b)))
})
