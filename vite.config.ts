import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { buildNotices } from './scripts/notices.ts'

/** Ships the licence notices of the bundled libraries next to the app as /THIRD_PARTY_NOTICES.txt. */
const notices = (): Plugin => ({
  name: 'third-party-notices', apply: 'build',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: buildNotices() }) },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), notices()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
