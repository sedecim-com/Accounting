import { defineConfig } from 'vitest/config';

/** Suite de INTEGRACIÓN: base efímera creada y destruida por corrida.
 *  En serie a propósito: comparten base y varias pruebas cuentan filas. */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.int.spec.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
