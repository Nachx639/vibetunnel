/**
 * ESBuild configuration for VibeTunnel web client
 */
const fs = require('fs');
const { monacoPlugin } = require('./monaco-plugin.js');
const { clientBuildIdPlugin } = require('./client-build-id.js');
const { version } = require('../package.json');

const commonOptions = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.css': 'css',
    '.ttf': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
    '__APP_VERSION__': JSON.stringify(version),
  },
  external: [],
  plugins: [monacoPlugin],
  // Allow importing from node_modules without issues
  mainFields: ['module', 'main'],
  // Suppress large bundle warnings
  logLimit: 0,
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      useDefineForClassFields: false,
      sourceMap: true,
      inlineSourceMap: true,
      inlineSources: true,
    }
  }
};

const devOptions = {
  ...commonOptions,
  sourcemap: 'inline',
  sourcesContent: true,
  minify: false,
  define: {
    ...commonOptions.define,
    'process.env.NODE_ENV': '"development"',
    '__APP_VERSION__': JSON.stringify(version),
  },
};

const prodOptions = {
  ...commonOptions,
  sourcemap: false,
  minify: true,
};

/**
 * The app bundle is built with code splitting so code loaded through `import()` (the
 * non-English locales) stays out of the bundle every client downloads first. The entry keeps
 * its old path, public/bundle/client-bundle.js; lazy chunks land in public/bundle/chunks/,
 * which every package (npm, Mac app, Docker) already ships as part of public/.
 */
const CLIENT_CHUNKS_DIR = 'public/bundle/chunks';
const clientAppBuild = {
  entryPoints: { 'client-bundle': 'src/client/app-entry.ts' },
  outdir: 'public/bundle',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // Written by the plugin: the bundle gets its build id, the stylesheet build reads it, and no
  // file is ever half-written (scripts/client-build-id.js). Build the stylesheet after this
  // build.
  write: false,
  plugins: [...commonOptions.plugins, clientBuildIdPlugin],
};

/** Chunk names carry a content hash: drop the previous build's before writing new ones. */
function cleanClientChunks() {
  fs.rmSync(CLIENT_CHUNKS_DIR, { recursive: true, force: true });
}

module.exports = {
  commonOptions,
  devOptions,
  prodOptions,
  clientAppBuild,
  cleanClientChunks,
};