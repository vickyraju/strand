// Writes server/openapi.json from the live route schemas. Needs no database: `npm run openapi`.
import { writeFileSync } from 'node:fs'

delete process.env.DATABASE_URL            // skip the LISTEN connection
Object.assign(process.env, { AUTH_DEV: '1', NODE_ENV: 'test' })
const { build } = await import('../src/app.ts')
const app = await build()
await app.ready()
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(app.swagger(), null, 2) + '\n')
await app.close()
console.log('wrote server/openapi.json')
