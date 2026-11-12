// Writes server/openapi.json from the live route schemas. Needs no database: `npm run openapi`.
import { writeFileSync } from 'node:fs'

delete process.env.DATABASE_URL            // skip the LISTEN connection
Object.assign(process.env, { NODE_ENV: 'test', ENTRA_TENANT_ID: 'tenant', ENTRA_CLIENT_ID: 'client' })   // placeholders: nothing signs in here
const { build } = await import('../src/app.ts')
const app = await build()
await app.ready()
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(app.swagger(), null, 2) + '\n')
await app.close()
console.log('wrote server/openapi.json')
