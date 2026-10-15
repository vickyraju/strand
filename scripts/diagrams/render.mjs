// Renders a .drawio page to PNG with draw.io's own viewer in headless Chrome, for a visual check.
//   node scripts/diagrams/render.mjs <file.drawio> <outDir> [pageIndex=0] [scale=1]
// Needs Google Chrome (macOS path below, or set CHROME) and network access to viewer.diagrams.net.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'

const [file, outDir, pageArg = '0', scaleArg = '1'] = process.argv.slice(2)
if (!file || !outDir) { console.error('usage: render.mjs <file.drawio> <outDir> [page] [scale]'); process.exit(2) }
const xml = readFileSync(file, 'utf8')
const page = Number(pageArg), scale = Number(scaleArg)
const sizes = [...xml.matchAll(/pageWidth="(\d+)" pageHeight="(\d+)"/g)].map(m => [Number(m[1]), Number(m[2])])
const [w, h] = sizes[page] ?? [1600, 1000]
mkdirSync(outDir, { recursive: true })
const config = { highlight: '#0000ff', nav: false, resize: false, toolbar: '', page, xml, 'auto-fit': false, zoom: scale }
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff}</style></head><body>
<div class="mxgraph" style="width:${w * scale}px;height:${h * scale}px" data-mxgraph="${JSON.stringify(config).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>
<script src="https://viewer.diagrams.net/js/viewer-static.min.js"></script></body></html>`
const htmlPath = resolve(outDir, `${basename(file, '.drawio')}-p${page}.html`)
const png = resolve(outDir, `${basename(file, '.drawio')}-p${page}.png`)
writeFileSync(htmlPath, html)
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', `--window-size=${w * scale},${h * scale}`, '--virtual-time-budget=20000', `--screenshot=${png}`, `file://${htmlPath}`], { stdio: 'ignore', timeout: 120000 })
console.log(png)
