// Quartz cron, as Jira stores filter subscription schedules (spec 0604 R2): seconds minutes hours day-of-month month
// day-of-week [year], in the server's time zone. `*`, `?`, lists, ranges, steps, day and month names; L (the last day of the
// month) in day-of-month; nL (the last such weekday) and n#k (the k-th) in day-of-week, where 1 is Sunday. W isn't supported.

export class CronError extends Error {}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** The values a field allows (null: any). */
function values(src: string, min: number, max: number, what: string, names?: string[]): Set<number> | null {
  if (src === '*' || src === '?') return null
  const out = new Set<number>()
  const num = (s: string) => {
    const i = names?.indexOf(s.toUpperCase()) ?? -1
    const n = i >= 0 ? i + min : /^\d+$/.test(s) ? Number(s) : NaN
    if (!(n >= min && n <= max)) throw new CronError(`${what}: “${s}” isn’t between ${min} and ${max}`)
    return n
  }
  for (const part of src.split(',')) {
    const [range, step] = part.split('/') as [string, string | undefined]
    const by = step === undefined ? 1 : /^\d+$/.test(step) && Number(step) > 0 ? Number(step) : NaN
    if (Number.isNaN(by)) throw new CronError(`“${part}” has a step that isn’t a number`)
    const [a, b] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(num) as [number, number] : [num(range), step ? max : num(range)]
    if (a > b) throw new CronError(`“${part}” runs backwards`)
    for (let n = a; n <= b; n += by) out.add(n)
  }
  return out
}

interface Cron { sec: Set<number> | null; min: Set<number> | null; hour: Set<number> | null; month: Set<number> | null; year: Set<number> | null
  dom: { any: true } | { last: true } | { days: Set<number> }
  dow: { any: true } | { last: number } | { nth: [number, number] } | { days: Set<number> } }

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/)
  if (f.length < 6 || f.length > 7) throw new CronError('A cron expression has six or seven parts: seconds minutes hours day-of-month month day-of-week [year]')
  const [s, mi, h, dom, mo, dow, y] = f as [string, string, string, string, string, string, string | undefined]
  if (/W/i.test(dom)) throw new CronError('W (the nearest weekday) isn’t supported')
  if (dom !== '?' && dow !== '?' && !(dom === '*' && dow === '*')) throw new CronError('Use ? in day-of-month or in day-of-week')
  const d = dow.toUpperCase()
  const day = (x: string) => { const i = DAYS.indexOf(x); const n = i >= 0 ? i + 1 : Number(x); if (!(n >= 1 && n <= 7)) throw new CronError(`“${x}” isn’t a day of the week (1 to 7, SUN to SAT)`); return n }
  return {
    sec: values(s, 0, 59, 'seconds'), min: values(mi, 0, 59, 'minutes'), hour: values(h, 0, 23, 'hours'),
    month: values(mo, 1, 12, 'months', MONTHS), year: y ? values(y, 1970, 2199, 'years') : null,
    dom: dom === '*' || dom === '?' ? { any: true } : dom.toUpperCase() === 'L' ? { last: true } : { days: values(dom, 1, 31, 'days of the month')! },
    dow: d === '*' || d === '?' ? { any: true }
      : /^\w+L$/.test(d) ? { last: day(d.slice(0, -1)) }
      : /^\w+#[1-5]$/.test(d) ? { nth: [day(d.split('#')[0]!), Number(d.split('#')[1])] }
      : { days: values(d, 1, 7, 'days of the week', DAYS)! },
  }
}

const has = (s: Set<number> | null, n: number) => !s || s.has(n)

/** The first time after `after` the expression fires, or null within the next five years. */
export function nextRun(expr: string, after: Date): Date | null {
  const c = parseCron(expr)
  const day = new Date(after); day.setHours(0, 0, 0, 0)
  for (let i = 0; i < 366 * 5; i++, day.setDate(day.getDate() + 1)) {
    const y = day.getFullYear(), m = day.getMonth() + 1, dd = day.getDate(), wd = day.getDay() + 1
    const monthDays = new Date(y, m, 0).getDate()
    if (!has(c.year, y) || !has(c.month, m)) continue
    if ('last' in c.dom && dd !== monthDays) continue
    if ('days' in c.dom && !c.dom.days.has(dd)) continue
    if ('last' in c.dow && (wd !== c.dow.last || dd + 7 <= monthDays)) continue
    if ('nth' in c.dow && (wd !== c.dow.nth[0] || Math.ceil(dd / 7) !== c.dow.nth[1])) continue
    if ('days' in c.dow && !c.dow.days.has(wd)) continue
    for (let h = 0; h < 24; h++) {
      if (!has(c.hour, h)) continue
      for (let mi = 0; mi < 60; mi++) {
        if (!has(c.min, mi)) continue
        for (let s = 0; s < 60; s++) {
          if (!has(c.sec, s)) continue
          const t = new Date(y, m - 1, dd, h, mi, s)
          if (t > after) return t
        }
      }
    }
  }
  return null
}
