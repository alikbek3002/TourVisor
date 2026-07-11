import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // The sources use NodeNext-style ".js" import specifiers that actually point
    // at ".ts" files. Strip the extension so Vite resolves the TypeScript source.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' }],
  },
});
