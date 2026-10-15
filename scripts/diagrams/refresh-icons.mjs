// Rebuilds aws4-names.txt (every AWS icon draw.io knows) from draw.io's own source, so diagram builds can reject a misspelt icon.
// Run only when updating the list:  node scripts/diagrams/refresh-icons.mjs
import { writeFileSync } from 'node:fs'

const url = 'https://raw.githubusercontent.com/jgraph/drawio/dev/src/main/webapp/js/diagramly/sidebar/Sidebar-AWS4.js'
const src = await (await fetch(url)).text()
const out = new Set()
for (const m of src.matchAll(/resIcon=' \+ gn \+ '\.([a-zA-Z0-9_]+)/g)) out.add('resIcon:' + m[1])          // service squares
for (const m of src.matchAll(/\bn\d* \+ '([a-zA-Z0-9_]+);'/g)) out.add('shape:' + m[1])                      // bare resource shapes
for (const m of src.matchAll(/grIcon=(?:' \+ gn \+ '\.|mxgraph\.aws4\.)([a-zA-Z0-9_]+)/g)) out.add('grIcon:' + m[1])   // group frames
writeFileSync(new URL('./aws4-names.txt', import.meta.url), [...out].sort().join('\n') + '\n')
console.log(out.size, 'icon names written')
