// Look and feel (spec 0702), as Jira's: the site title, logo, favicon and brand colour. One row for the whole system,
// read before anyone signs in (the login page shows it); cached on each server for a few seconds.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { BRAND_DEFAULT, brandReadable } from '../shared/brand.ts'
import { requireNoToken } from './authentication.ts'

const T = ['Look and feel']
const LIMIT = { logo: 256 * 1024, favicon: 64 * 1024, mark: 64 * 1024 }   // mark: the collapsed menu's logo (spec 0719)
const IMAGES = ['logo', 'favicon', 'mark'] as const
const NAMES = { logo: 'logo', favicon: 'favicon', mark: 'collapsed menu logo' }
interface Row { siteTitle: string; showTitle: boolean; brandColor: string; logoType: string | null; faviconType: string | null; markType: string | null; updatedAt: string }

let cached: { at: number; value: Row } | null = null
async function look(): Promise<Row> {
  if (cached && Date.now() - cached.at < 10_000) return cached.value
  const [r] = await db.query<Row>('select site_title, show_title, brand_color, logo_type, favicon_type, mark_type, updated_at from look_and_feel')
  cached = { at: Date.now(), value: r! }
  return r!
}
const clear = () => { cached = null }

/** An image's type from its first bytes (R3): PNG, JPEG or WebP; anything else (SVG, HTML…) is refused. */
export function imageType(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const view = (r: Row) => {
  const v = createHash('sha1').update(r.updatedAt).digest('hex').slice(0, 8)
  return {
    siteTitle: r.siteTitle, showTitle: r.showTitle, brandColor: r.brandColor,
    logo: r.logoType ? `/look-and-feel/logo?v=${v}` : null, favicon: r.faviconType ? `/look-and-feel/favicon?v=${v}` : null,
    mark: r.markType ? `/look-and-feel/mark?v=${v}` : null,
  }
}

/** No sign-in needed: the login page draws with it. */
export const publicLook: FastifyPluginAsyncZod = async app => {
  app.get('/look-and-feel', { schema: { tags: T, summary: 'The site title, brand colour, and the logo’s and favicon’s addresses (no sign-in needed)' } }, async () => view(await look()))
  for (const which of IMAGES) {
    app.get(`/look-and-feel/${which}`, { schema: { tags: T, summary: `The ${NAMES[which]} image (no sign-in needed)`, hide: true } }, async (req, reply) => {
      const [r] = await db.query<{ data: Buffer | null; type: string | null; updatedAt: string }>(`select ${which} as data, ${which}_type as type, updated_at from look_and_feel`)
      if (!r?.data || !r.type) throw new HttpError(404, `No ${which}`)
      const etag = `"${createHash('sha1').update(r.data).digest('hex')}"`
      reply.headers({ 'content-type': r.type, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'public, max-age=86400', etag })
      if (req.headers['if-none-match'] === etag) return reply.code(304).send()
      return reply.send(r.data)
    })
  }
}

const lookAndFeel: FastifyPluginAsyncZod = async app => {
  app.put('/admin/look-and-feel', { schema: { tags: T, summary: 'Change the site title and brand colour (system administrators)',
    body: z.object({
      siteTitle: z.string().trim().min(1).max(60), showTitle: z.boolean(),
      brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour such as #368727').transform(c => c.toUpperCase()),
    }) } }, async req => {
    requireNoToken(req)
    const b = req.body
    if (!brandReadable(b.brandColor)) throw new HttpError(400, 'White text on this colour is hard to read: choose a darker one (contrast at least 4.5 to 1)', { brandColor: 'Too light for white text' })
    await tx(async d => {
      const [before] = await d.query<Row>('select site_title, show_title, brand_color from look_and_feel for update')
      await d.query('update look_and_feel set site_title = $1, show_title = $2, brand_color = $3, updated_at = now(), updated_by = $4', [b.siteTitle, b.showTitle, b.brandColor, req.me.id])
      const c = changes({ siteTitle: before!.siteTitle, showTitle: before!.showTitle, brandColor: before!.brandColor }, b)
      if (c.changed) await audit(d, req, { action: 'look_and_feel.updated', type: 'settings', name: 'Look and feel', before: c.before, after: c.after })
    })
    clear()
    return view(await look())
  })

  for (const which of IMAGES) {
    app.put(`/admin/look-and-feel/${which}`, { bodyLimit: 1024 * 1024, schema: { tags: T, summary: `Upload the ${NAMES[which]}: PNG, JPEG or WebP, base64 (system administrators)`,
      body: z.object({ image: z.string().max(Math.ceil(LIMIT[which] * 4 / 3) + 8).describe('The image, base64') }) } }, async req => {
      requireNoToken(req)
      const data = Buffer.from(req.body.image.replace(/^data:[^,]*,/, ''), 'base64')
      const type = imageType(data)
      if (!type) throw new HttpError(400, 'Use a PNG, JPEG or WebP image', { image: 'Not a PNG, JPEG or WebP image' })
      if (data.length > LIMIT[which]) throw new HttpError(400, `The ${NAMES[which]} can be at most ${LIMIT[which] / 1024} KB`, { image: 'Too large' })
      await tx(async d => {
        await d.query(`update look_and_feel set ${which} = $1, ${which}_type = $2, updated_at = now(), updated_by = $3`, [data, type, req.me.id])
        await audit(d, req, { action: `look_and_feel.${which}_changed`, type: 'settings', name: 'Look and feel', after: { [which]: `${type}, ${Math.ceil(data.length / 1024)} KB` } })
      })
      clear()
      return view(await look())
    })
    app.delete(`/admin/look-and-feel/${which}`, { schema: { tags: T, summary: `Remove the ${NAMES[which]}: Jira Build POC’s own shows again (system administrators)` } }, async req => {
      requireNoToken(req)
      await tx(async d => {
        await d.query(`update look_and_feel set ${which} = null, ${which}_type = null, updated_at = now(), updated_by = $1`, [req.me.id])
        await audit(d, req, { action: `look_and_feel.${which}_removed`, type: 'settings', name: 'Look and feel' })
      })
      clear()
      return view(await look())
    })
  }

  app.delete('/admin/look-and-feel', { schema: { tags: T, summary: 'Reset defaults: Jira Build POC’s title, logomark, favicon and colour (system administrators)' } }, async req => {
    requireNoToken(req)
    await tx(async d => {
      await d.query(`update look_and_feel set site_title = 'Jira Build POC', show_title = true, brand_color = $1, logo = null, logo_type = null, favicon = null, favicon_type = null, mark = null, mark_type = null, updated_at = now(), updated_by = $2`, [BRAND_DEFAULT, req.me.id])
      await audit(d, req, { action: 'look_and_feel.reset', type: 'settings', name: 'Look and feel' })
    })
    clear()
    return view(await look())
  })
}

export default lookAndFeel
