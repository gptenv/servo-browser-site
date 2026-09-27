import { build } from 'esbuild';

await build({
  entryPoints: ['scripts/servo-media-engine.mjs'],
  outfile: 'public/servo-media-engine.bundle.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'inline',
});
