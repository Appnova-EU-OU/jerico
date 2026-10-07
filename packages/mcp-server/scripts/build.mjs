import * as esbuild from 'esbuild'
import { writeFileSync, mkdirSync, chmodSync } from 'fs'

mkdirSync('./dist', { recursive: true })

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle:      true,
  platform:    'node',
  format:      'cjs',
  outfile:     'dist/index.cjs',
  banner:      { js: '#!/usr/bin/env node' },
  external: [
    // never bundle native modules
  ],
})

// Claude Code requires the MCP server command to be executable
chmodSync('dist/index.cjs', 0o755)

console.log('[bridge-mcp] build done → dist/index.cjs')
