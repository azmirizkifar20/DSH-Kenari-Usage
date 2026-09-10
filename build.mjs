// Dual host/client build for dsh-kenari-usage.
// Host half: `tsc -p tsconfig.json` emits dist/*.js + .d.ts
// (kenari-usage.js imports ./format.js, so the tsc output layout is kept).
// Client half: esbuild bundles src/client/index.ts into dist/client.js as a
// browser CJS bundle wrapped in window.__ModuleLoader__.load.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
})

// tsc typechecks src/client too (no separate tsconfig), but its per-file
// emit under dist/client/ is dead weight — the shell resolves the client half
// via exports["./client"] -> dist/client.js (the esbuild bundle below).
rmSync('dist/client', { recursive: true, force: true })

await esbuild.build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*', 'cordis'],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-kenari-usage", factory: (require) => {\nvar module={exports:{}};var exports=module.exports;',
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
})

console.log('[kenari-usage] build ok: dist/kenari-usage.js + dist/client.js')
