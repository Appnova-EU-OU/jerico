import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import sveltePreprocess from 'svelte-preprocess'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: './src/main/index.ts',
      },
    },
  },
  preload: {
    build: {
      lib: {
        // The intro window gets its own preload: it is the only window that
        // renders before the permission gate, and it has no business reaching
        // token validation or daemon lifecycle.
        entry: ['./src/preload/index.ts', './src/preload/intro.ts'],
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          intro: resolve('src/renderer/intro.html'),
          firstRun07: resolve('src/renderer/first-run/07-first-run-tour.html'),
          firstRun08: resolve('src/renderer/first-run/08-first-run-orchestrator.html'),
          firstRun09: resolve('src/renderer/first-run/09-first-run-close.html'),
        },
      },
    },
    plugins: [
      svelte({
        preprocess: sveltePreprocess(),
      }),
    ],
  },
})
