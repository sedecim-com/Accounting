import { defineConfig } from 'vitest/config';

/** Proyecto UNITARIO: rápido, sin base de datos. La suite de integración vive
 *  en vitest.integration.config.ts y se excluye aquí a propósito. */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
