import type express from 'express';

type StaticOptions = NonNullable<Parameters<typeof express.static>[1]>;

/** Cache policy for the web client's static files (public/). */
export function staticFileOptions(isDevelopment: boolean): StaticOptions {
  return {
    extensions: ['html'], // This allows /logs to resolve to /logs.html
    maxAge: isDevelopment ? 0 : '1d',
    // ETag/Last-Modified come from size+mtime, so a rebuild always changes them. With
    // `no-cache` the browser revalidates on every load and gets a 304 instead of
    // re-downloading the multi-MB bundle (dev mode used `no-store`).
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (isDevelopment) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(js|css|map|wasm|json)$/.test(filePath)) {
        // Bundle file names carry no content hash, so they must be revalidated: a year-long
        // `immutable` cache kept phones on the old client after an upgrade.
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
      }
    },
  };
}
