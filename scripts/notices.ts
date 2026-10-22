// Third-party licence notices for the web build. MIT and similar licences require the copyright and permission notice
// to ship with the software, and the bundler strips the comments that carry them, so this writes them out in full.
// Covers every runtime dependency and what those depend on (not build tools: they do not end up in the bundle).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Pkg { name: string; version: string; license: string; repository?: string; text?: string }

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

/** Find an installed package: next to the one that needs it, then up through the hoisted node_modules folders. */
function locate(name: string, from: string, root: string): string | undefined {
  for (let dir = from; ; dir = join(dir, '..')) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root || dir === join(dir, '..')) return undefined
  }
}

export function collectPackages(root: string): Pkg[] {
  const found = new Map<string, Pkg>()
  const visit = (name: string, from: string) => {
    const dir = locate(name, from, root)
    if (!dir) throw new Error(`Dependency ${name} is not installed; run npm ci before building`)
    const pkg = readJson(join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (found.has(key)) return
    const file = readdirSync(dir).find(f => /^(licen[sc]e|copying)(\.|$)/i.test(f))
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    found.set(key, {
      name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN',
      repository: repo?.replace(/^git\+/, '').replace(/\.git$/, ''), text: file ? readFileSync(join(dir, file), 'utf8').trim() : undefined,
    })
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir)
  }
  for (const dep of Object.keys(readJson(join(root, 'package.json')).dependencies ?? {})) visit(dep, root)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export function buildNotices(root = process.cwd()): string {
  const rule = '='.repeat(78)
  const parts = collectPackages(root).map(p => [
    rule, `${p.name} ${p.version}`, `License: ${p.license}`, ...(p.repository ? [p.repository] : []), '',
    p.text ?? `(No licence file ships with this package. It is published under ${p.license}.)`,
  ].join('\n'))
  return ['This product includes third-party software. Their licence notices follow.', '', ...parts, ''].join('\n\n')
}
