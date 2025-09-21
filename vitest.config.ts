import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Configure Vitest (https://vitest.dev/config/)
  test: {
    passWithNoTests: true,
    environment: 'node',
    reporters: ['verbose'],
    globals: true,
  },
});
