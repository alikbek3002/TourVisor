import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Unit tests must be deterministic regardless of a developer's local .env.
    // config.ts runs `dotenv/config` on import; point dotenv at an empty file so
    // tests always see the schema defaults, not real credentials/settings.
    env: { DOTENV_CONFIG_PATH: '/dev/null' },
  },
  resolve: {
    // The sources use NodeNext-style ".js" import specifiers that actually point
    // at ".ts" files. Strip the extension so Vite resolves the TypeScript source.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' }],
  },
});
