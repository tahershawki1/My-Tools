import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
