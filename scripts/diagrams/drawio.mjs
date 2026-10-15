// Minimal draw.io (mxGraph) XML builder. Plain Node, no dependencies.
// Produces uncompressed <mxfile> XML, which draw.io and the Confluence draw.io plugin open directly
// (File > Import, Extras > Edit Diagram, or as an attached .drawio file).
import { readFileSync } from 'node:fs'

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** {a: 1, b: 'x', text: ''} → "a=1;b=x;text;"  (undefined/null/false entries are dropped; true becomes 1; '' makes a bare token like `text` or `swimlane`, which draw.io needs for named styles) */
export const style = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => (v === '' ? k : `${k}=${v === true ? 1 : v}`)).join(';') + ';'

// ── AWS icons: only names draw.io actually has (a wrong name renders as an empty box) ──
const names = new Set(readFileSync(new URL('./aws4-names.txt', import.meta.url), 'utf8').split('\n').filter(Boolean))
const need = (kind, n) => { if (!names.has(`${kind}:${n}`)) throw new Error(`Unknown AWS icon ${kind}:${n} (see scripts/diagrams/aws4-names.txt)`); return n }

/** AWS category colours (from the AWS Architecture Icons set) */
export const AWS = { net: '#8C4FFF', compute: '#ED7100', db: '#C925D1', storage: '#7AA116', integ: '#E7157B', sec: '#DD344C', mgmt: '#E7157B', dev: '#C925D1', ink: '#232F3E', grey: '#545B64' }

export class Page {
  constructor(name, { width = 1600, height = 1000 } = {}) {
    this.name = name; this.width = width; this.height = height
    this.cells = new Map(); this.edges = []; this.seq = 1
    this.edgesBehind = false   // true: lines sit behind tables and show only in gaps (data model); false: lines on top (architecture)
    this.cells.set('1', { id: '1', parent: '0', x: 0, y: 0, w: width, h: height, root: true })
  }
  id(prefix = 'c') { return `${prefix}${++this.seq}` }

  /** Add a vertex. x/y are relative to `parent` ('1' = the page). Returns its id. */
  box({ id, parent = '1', x, y, w, h, value = '', st = {}, noOverlap = false, geometryExtra = '', back = false }) {
    id ??= this.id()
    if (this.cells.has(id)) throw new Error(`Duplicate id ${id}`)
    this.cells.set(id, { id, parent, x, y, w, h, value, style: typeof st === 'string' ? st : style(st), vertex: true, noOverlap, geometryExtra, back })
    return id
  }
  edge({ id, source, target, value = '', st = {}, points = [], parent = '1' }) {
    id ??= this.id('e')
    this.edges.push({ id, parent, source, target, value, style: typeof st === 'string' ? st : style(st), points })
    return id
  }

  // ── Building blocks ──
  /** AWS service square (resIcon) or bare resource shape, with a label under it. `planned` = dashed outline + tag. */
  aws(parent, kindName, color, x, y, label, { size = 56, planned = false, shape = false, id } = {}) {
    const base = { sketch: 0, outlineConnect: 0, fontColor: AWS.ink, dashed: 0, verticalLabelPosition: 'bottom', verticalAlign: 'top', align: 'center', html: 1, fontSize: 11, aspect: 'fixed', whiteSpace: 'nowrap' }
    const st = shape
      ? { ...base, gradientColor: 'none', fillColor: color, strokeColor: 'none', pointerEvents: 1, shape: `mxgraph.aws4.${need('shape', kindName)}` }
      : { ...base, gradientColor: 'none', fillColor: color, strokeColor: '#ffffff', shape: 'mxgraph.aws4.resourceIcon', resIcon: `mxgraph.aws4.${need('resIcon', kindName)}` }
    const iconId = this.box({ id, parent, x, y, w: size, h: size, value: label ? `${label}${planned ? '<br><font color="#B85450" style="font-size:9px"><b>PLANNED</b></font>' : ''}` : '', st })
    if (planned) {   // dashed frame around the icon + label so "not built yet" reads at a glance
      this.box({ parent, x: x - (150 - size) / 2, y: y - 8, w: 150, h: size + 62, st: { fillColor: 'none', strokeColor: '#B85450', dashed: 1, dashPattern: '4 3', rounded: 1, arcSize: 6, strokeWidth: 1.5, pointerEvents: 0 }, noOverlap: true })
    }
    return iconId
  }
  /** AWS group frame: aws_cloud_alt, region, vpc2, security_group … (a label sits in the corner) */
  group(parent, grIcon, x, y, w, h, label, o = {}) {
    if (!names.has(`grIcon:${grIcon}`)) throw new Error(`Unknown AWS group icon ${grIcon}`)
    return this.box({ id: o.id, parent, x, y, w, h, value: esc(label),
      st: { sketch: 0, outlineConnect: 0, gradientColor: 'none', html: 1, whiteSpace: 'wrap', fontSize: 12, fontStyle: 0, container: 1, pointerEvents: 0, shape: 'mxgraph.aws4.group', grIcon: `mxgraph.aws4.${grIcon}`,
        strokeColor: o.stroke ?? '#147EBA', fillColor: o.fill ?? 'none', verticalAlign: 'top', align: 'left', spacingLeft: 30, fontColor: o.font ?? o.stroke ?? '#147EBA', dashed: o.dashed ? 1 : 0, dashPattern: o.dashed ? '6 4' : undefined, strokeWidth: o.dashed ? 1.5 : 1 } })
  }
  /** Plain rounded container with a title (subnet tiers, bands, panels) */
  panel(parent, x, y, w, h, title, o = {}) {
    return this.box({ id: o.id, parent, x, y, w, h, value: esc(title), st: { rounded: 1, arcSize: o.arc ?? 3, whiteSpace: 'wrap', html: 1, container: 1, collapsible: 0, fillColor: o.fill ?? 'none', strokeColor: o.stroke ?? '#879196', dashed: o.dashed ? 1 : 0, dashPattern: o.dashed ? '6 4' : undefined,
      strokeWidth: o.dashed ? 1.5 : 1, verticalAlign: 'top', align: 'left', spacingLeft: 10, spacingTop: 4, fontSize: o.size ?? 12, fontStyle: o.bold === false ? 0 : 1, fontColor: o.font ?? '#232F3E' } })
  }
  /** Free text / simple label box */
  text(parent, x, y, w, h, html, o = {}) {
    return this.box({ id: o.id, parent, x, y, w, h, value: html, noOverlap: o.noOverlap ?? false, st: { text: o.fill ? undefined : '', html: 1, whiteSpace: 'wrap', align: o.align ?? 'left', verticalAlign: o.valign ?? 'top', fontSize: o.size ?? 11, fontColor: o.color ?? '#232F3E', rounded: o.fill ? 1 : undefined, arcSize: o.fill ? 8 : undefined, fillColor: o.fill, strokeColor: o.stroke ?? (o.fill ? '#879196' : 'none'), dashed: o.dashed ? 1 : 0, dashPattern: o.dashed ? '4 3' : undefined, spacing: o.spacing ?? 4, fontStyle: o.bold ? 1 : 0 } })
  }

  // ── Checks (used by tests; a diagram that fails these is not written) ──
  abs(c) { let x = c.x, y = c.y, p = this.cells.get(c.parent); while (p && !p.root) { x += p.x; y += p.y; p = this.cells.get(p.parent) } return { x, y, w: c.w, h: c.h } }
  problems() {
    const out = []
    for (const c of this.cells.values()) {
      if (c.root) continue
      if (!this.cells.has(c.parent)) out.push(`${c.id}: parent ${c.parent} missing`)
      const p = this.cells.get(c.parent)
      if (p && !p.root && (c.x < 0 || c.y < 0 || c.x + c.w > p.w + 0.5 || c.y + c.h > p.h + 0.5)) out.push(`${c.id} "${strip(c.value)}" sticks out of ${p.id} "${strip(p.value)}"`)
    }
    const byParent = new Map()
    for (const c of this.cells.values()) if (c.vertex && !c.noOverlap) (byParent.get(c.parent) ?? byParent.set(c.parent, []).get(c.parent)).push(c)
    for (const sibs of byParent.values()) for (let i = 0; i < sibs.length; i++) for (let j = i + 1; j < sibs.length; j++) {
      const a = sibs[i], b = sibs[j]
      if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) out.push(`overlap: ${a.id} "${strip(a.value)}" and ${b.id} "${strip(b.value)}"`)
    }
    const ids = new Set([...this.cells.keys()])
    for (const e of this.edges) {
      if (!ids.has(e.source)) out.push(`edge ${e.id}: source ${e.source} missing`)
      if (!ids.has(e.target)) out.push(`edge ${e.id}: target ${e.target} missing`)
      if (ids.has(e.id)) out.push(`edge ${e.id}: id clashes with a vertex`)
    }
    return out
  }

  xml(index) {
    const out = [`  <diagram id="page-${index}" name="${esc(this.name)}">`,
      `    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${this.width}" pageHeight="${this.height}" math="0" shadow="0">`,
      '      <root>', '        <mxCell id="0"/>', '        <mxCell id="1" parent="0"/>']
    const cell = c => out.push(`        <mxCell id="${c.id}" value="${esc(c.value)}" style="${esc(c.style)}" vertex="1" parent="${c.parent}">`,
      `          <mxGeometry x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" as="geometry"${c.geometryExtra ? '>' + c.geometryExtra + '</mxGeometry>' : '/>'}`, '        </mxCell>')
    const all = [...this.cells.values()].filter(c => !c.root)
    const edgeXml = e => {
      const pts = e.points.length ? `<Array as="points">${e.points.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('')}</Array>` : ''
      out.push(`        <mxCell id="${e.id}" value="${esc(e.value)}" style="${esc(e.style)}" edge="1" parent="${e.parent}" source="${e.source}" target="${e.target}">`,
        `          <mxGeometry relative="1" as="geometry">${pts}</mxGeometry>`, '        </mxCell>')
    }
    for (const c of all.filter(c => c.back)) cell(c)          // backgrounds first
    if (this.edgesBehind) this.edges.forEach(edgeXml)         // lines behind the content: only visible in the gaps
    for (const c of all.filter(c => !c.back)) cell(c)         // content
    if (!this.edgesBehind) this.edges.forEach(edgeXml)        // lines on top of everything
    out.push('      </root>', '    </mxGraphModel>', '  </diagram>')
    return out.join('\n')
  }
}

const strip = s => String(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)

/** All pages → one uncompressed .drawio document */
export function drawioFile(pages, { name = 'diagram' } = {}) {
  return `<mxfile host="app.diagrams.net" agent="jira-build-diagrams" version="24.0.0" type="device" compressed="false" name="${esc(name)}">\n${pages.map((p, i) => p.xml(i + 1)).join('\n')}\n</mxfile>\n`
}

/** Edge presets */
export const flow = (color, o = {}) => ({ edgeStyle: 'orthogonalEdgeStyle', rounded: 1, orthogonalLoop: 1, jettySize: 'auto', html: 1, strokeColor: color, strokeWidth: 2, endArrow: 'block', endFill: 1, fontSize: 10, fontColor: color, fontStyle: 1, labelBackgroundColor: '#ffffff', ...o })
