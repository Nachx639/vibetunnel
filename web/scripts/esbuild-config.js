/**
 * ESBuild configuration for VibeTunnel web client
 */
const { monacoPlugin } = require('./monaco-plugin.js');
const fs = require('fs');
const { version } = require('../package.json');

/**
 * ghostty-web ships its WASM a second time as a ~564 KB base64 data URL inside its JS, only for
 * `Ghostty.load()` without a path. The app always loads `/ghostty-vt.wasm` (copied to public/ by
 * copy-assets.js), so point that fallback at the served file instead of shipping the blob to every
 * phone. If a ghostty-web update changes the shape, warn rather than fail the build.
 */
const ghosttyWasmDataUrlPlugin = {
  name: 'ghostty-wasm-data-url',
  setup(build) {
    build.onLoad({ filter: /ghostty-web[\\/]dist[\\/]ghostty-web\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const stripped = source.replace(
        /"data:application\/wasm;base64,[A-Za-z0-9+/=]+"/,
        '"/ghostty-vt.wasm"'
      );
      const warnings =
        stripped === source
          ? [{ text: 'ghostty-web embedded WASM data URL not found; bundle keeps the inline copy' }]
          : [];
      return { contents: stripped, loader: 'js', warnings };
    });
  },
};

const devMinify = ['1', 'true'].includes(process.env.VIBETUNNEL_DEV_MINIFY ?? '');

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
  plugins: [monacoPlugin, ghosttyWasmDataUrlPlugin],
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
  // Linked (external) maps: an inline map was ~4.7 MB of the 6.9 MB dev bundle that every
  // client downloaded on each load. Browsers only fetch the .map when DevTools is open.
  sourcemap: 'linked',
  sourcesContent: true,
  // VIBETUNNEL_DEV_MINIFY=1 minifies the dev build too, for a dev server used from phones:
  // every cold start parses 1.84 MB of unminified JS, 1.33 MB minified (−28 %). keepNames
  // keeps class/function names (logs, custom elements); linked maps keep it debuggable.
  // Default off: the dev build stays unminified as before.
  minify: devMinify,
  keepNames: devMinify,
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

module.exports = {
  commonOptions,
  devOptions,
  prodOptions,
};