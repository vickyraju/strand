import { build } from './app.ts'

const app = await build()
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })
const stop = () => app.close().then(() => process.exit(0))   // let in-flight requests finish on pod shutdown
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
