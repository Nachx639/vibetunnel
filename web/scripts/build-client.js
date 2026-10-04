const { execSync } = require('child_process');
const esbuild = require('esbuild');
const { prodOptions, clientAppBuild, cleanClientChunks } = require('./esbuild-config.js');

async function buildClient() {
  console.log('Building client bundles for tests...');

  execSync('node scripts/ensure-dirs.js', { stdio: 'inherit' });
  execSync('node scripts/copy-assets.js', { stdio: 'inherit' });

  execSync('pnpm exec postcss ./src/client/styles.css -o ./public/bundle/styles.css', {
    stdio: 'inherit',
  });

  cleanClientChunks();
  await esbuild.build({
    ...prodOptions,
    ...clientAppBuild,
  });

  await esbuild.build({
    ...prodOptions,
    entryPoints: ['src/client/test-entry.ts'],
    outfile: 'public/bundle/test.js',
  });

  await esbuild.build({
    ...prodOptions,
    entryPoints: ['src/client/sw.ts'],
    outfile: 'public/sw.js',
    format: 'iife',
  });

  console.log('Client bundles built successfully');
}

buildClient().catch((error) => {
  console.error('Client build failed:', error);
  process.exit(1);
});

