// Reading test results from CI in the formats Xray accepts (its "Import Execution Results" page): Xray JSON, JUnit XML
// (with Xray's extra properties: test_key, test_summary, requirements, testrun_comment) and Cucumber JSON. Each format
// becomes the same batch: what the execution is, and one result per test. Matching to tests and saving happens elsewhere.

export interface StepResult { status: string; actual?: string; comment?: string }
export interface TestInfo { projectKey?: string; summary: string; kind: 'manual' | 'cucumber' | 'generic'; definition?: string; gherkin?: string; steps?: { action: string; data: string; expected: string }[] }
export interface Result {
  testKey?: string                 // an existing test
  tagKeys?: string[]               // Cucumber tags that look like keys: a Test (which test) or a requirement (what it covers)
  info?: TestInfo                  // otherwise: find the test by this (summary or definition), or create it
  status: string; start?: string; finish?: string; comment?: string
  steps?: StepResult[]; requirements?: string[]; defects?: string[]
}
export interface Batch {
  info: { projectKey?: string; summary?: string; description?: string; testExecKey?: string; testPlanKey?: string; environments: string[]; revision?: string; version?: string }
  results: Result[]
}
export class ImportError extends Error {}
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? undefined : String(v))

// ── XML: just enough for JUnit reports. DOCTYPE and entity declarations are skipped, never expanded. ──
export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!)
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const top = stack[stack.length - 1]!
    if (lt < 0) { top.text += decode(src.slice(i)); break }
    if (lt > i) top.text += decode(src.slice(i, lt))
    const skip = (open: string, close: string) => { if (!src.startsWith(open, lt)) return false; const e = src.indexOf(close, lt + open.length); if (e < 0) throw new ImportError('The XML is cut off'); i = e + close.length; return true }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); if (e < 0) throw new ImportError('The XML is cut off'); top.text += src.slice(lt + 9, e); i = e + 3; continue }
    if (skip('<!--', '-->') || skip('<?', '?>')) continue
    if (src.startsWith('<!', lt)) {                                             // <!DOCTYPE …> (with an internal subset or not): ignored
      let depth = 0, j = lt + 2
      for (; j < src.length; j++) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; else if (src[j] === '>' && depth <= 0) break }
      i = j + 1; continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) throw new ImportError('The XML is cut off')
    const tag = src.slice(lt + 1, gt)
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim()
      if (top.name !== name) throw new ImportError(`The XML doesn’t close <${top.name}> where it should`)
      stack.pop(); i = gt + 1; continue
    }
    const self = tag.endsWith('/')
    const m = /^([^\s/>]+)([\s\S]*?)\/?$/.exec(tag)
    if (!m) throw new ImportError('The XML has a broken tag')
    const node: XNode = { name: m[1]!, attrs: {}, children: [], text: '' }
    for (const a of m[2]!.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[a[1]!] = decode(a[3] ?? a[4] ?? '')
    top.children.push(node)
    if (!self) stack.push(node)
    i = gt + 1
  }
  if (stack.length > 1) throw new ImportError(`The XML doesn’t close <${stack[stack.length - 1]!.name}>`)
  return root
}
const all = (n: XNode, name: string): XNode[] => n.children.flatMap(c => (c.name === name ? [c] : []).concat(all(c, name)))

/** JUnit XML: each <testcase> is a generic test (definition: class name and test name), passed unless it has a
 *  <failure> or <error> (FAIL) or is <skipped> (TODO). Xray's properties name the test, its requirements and a comment. */
export function fromJunit(xml: string): Batch {
  const doc = parseXml(xml)
  const cases = all(doc, 'testcase')
  if (!cases.length && !all(doc, 'testsuite').length) throw new ImportError('This isn’t a JUnit report: no <testsuite> or <testcase>')
  const results = cases.map<Result>(c => {
    const props = Object.fromEntries(all(c, 'property').map(p => [p.attrs.name ?? '', p.attrs.value ?? p.text.trim()]))
    const failed = c.children.find(x => x.name === 'failure' || x.name === 'error')
    const skipped = c.children.some(x => x.name === 'skipped')
    const name = c.attrs.name ?? 'unnamed test', cls = c.attrs.classname
    const definition = cls ? `${cls}.${name}` : name
    const comment = [props.testrun_comment, failed ? [failed.attrs.message, failed.text.trim()].filter(Boolean).join('\n') : ''].filter(Boolean).join('\n\n')
    return {
      ...(props.test_key ? { testKey: props.test_key } : {}),
      info: { summary: props.test_summary || name, kind: 'generic', definition },
      status: failed ? 'FAIL' : skipped ? 'TODO' : 'PASS',
      ...(comment ? { comment } : {}),
      ...(props.requirements ? { requirements: props.requirements.split(/[,\s]+/).filter(Boolean) } : {}),
    }
  })
  return { info: { environments: [] }, results }
}

/** Cucumber JSON: each scenario is a Cucumber test, named by a tag with its key or found by its name. Passed if every step
 *  passed, failed if one failed, otherwise still to do. Other key-like tags are requirements it covers. */
export function fromCucumber(json: unknown): Batch {
  if (!Array.isArray(json)) throw new ImportError('Cucumber results are a JSON list of features')
  const results: Result[] = []
  for (const f of json as any[]) for (const sc of Array.isArray(f?.elements) ? f.elements : []) {
    if (sc?.type && sc.type !== 'scenario') continue                         // backgrounds
    const steps = Array.isArray(sc.steps) ? sc.steps : []
    const st = steps.map((s: any) => str(s?.result?.status) ?? 'undefined')
    const status = st.includes('failed') ? 'FAIL' : st.length && st.every((s: string) => s === 'passed') ? 'PASS' : 'TODO'
    const errors = steps.map((s: any) => str(s?.result?.error_message)).filter(Boolean)
    const tagKeys = (Array.isArray(sc.tags) ? sc.tags : []).map((t: any) => String(t?.name ?? '').replace(/^@(TEST_)?/i, '')).filter((k: string) => KEY.test(k)).map((k: string) => k.toUpperCase())
    const name = str(sc.name)?.trim() || 'unnamed scenario'
    const gherkin = [`${str(sc.keyword)?.trim() || 'Scenario'}: ${name}`, ...steps.map((s: any) => `  ${str(s?.keyword)?.trim() ?? ''} ${str(s?.name) ?? ''}`.trimEnd())].join('\n')
    results.push({ ...(tagKeys.length ? { tagKeys } : {}), info: { summary: name, kind: 'cucumber', gherkin }, status, ...(errors.length ? { comment: errors.join('\n\n') } : {}) })
  }
  return { info: { environments: [] }, results }
}

/** Xray JSON (Xray's own format, for manual tests and tools Xray doesn't know). */
export function fromXrayJson(body: any): Batch {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tests)) throw new ImportError('Xray JSON needs a "tests" list')
  const i = body.info ?? {}
  const kind = (t: unknown) => { const k = String(t ?? 'generic').toLowerCase(); return k === 'manual' || k === 'cucumber' ? k : 'generic' }
  return {
    info: {
      projectKey: str(i.project), summary: str(i.summary), description: str(i.description), testExecKey: str(body.testExecutionKey), testPlanKey: str(i.testPlanKey),
      environments: Array.isArray(i.testEnvironments) ? i.testEnvironments.map(String) : [], revision: str(i.revision), version: str(i.version),
    },
    results: body.tests.map((t: any): Result => {
      const ti = t.testInfo
      if (!t.testKey && !ti?.summary) throw new ImportError('Each test needs a testKey or a testInfo with a summary')
      return {
        ...(t.testKey ? { testKey: String(t.testKey) } : {}),
        ...(ti ? { info: {
          projectKey: str(ti.projectKey), summary: String(ti.summary ?? t.testKey), kind: kind(ti.testType ?? ti.type) as TestInfo['kind'],
          definition: str(ti.definition), gherkin: str(ti.scenario ?? ti.definition),
          steps: Array.isArray(ti.steps) ? ti.steps.map((s: any) => ({ action: String(s.action ?? ''), data: String(s.data ?? ''), expected: String(s.result ?? s.expected ?? '') })) : undefined,
        } } : {}),
        status: String(t.status ?? 'TODO'), start: str(t.start), finish: str(t.finish), comment: str(t.comment),
        steps: Array.isArray(t.steps) ? t.steps.map((s: any) => ({ status: String(s.status ?? 'TODO'), actual: str(s.actualResult), comment: str(s.comment) })) : undefined,
        requirements: Array.isArray(ti?.requirementKeys) ? ti.requirementKeys.map(String) : undefined,
        defects: Array.isArray(t.defects) ? t.defects.map(String) : undefined,
      }
    }),
  }
}
