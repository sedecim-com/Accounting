import { defineConfig } from 'vitest/config';

/** Proyecto UNITARIO: rápido, sin base de datos. La suite de integración vive
 *  en vitest.integration.config.ts y se excluye aquí a propósito. */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Solo el motor contable: medir todo el árbol produce un porcentaje
      // global que baja cuando alguien agrega un archivo y sube cuando lo
      // borra, y que por eso nadie mira.
      include: ['src/services/accounting/**', 'src/utils/sequence.ts'],
      // ============================================================
      // UMBRALES POR ARCHIVO, FIJADOS DONDE YA ESTÁN GANADOS
      //
      // Un umbral global es un promedio: deja que la cobertura de una pieza
      // crítica caiga mientras otra sube. Éstos son trinquetes por archivo —
      // están puestos justo debajo de lo medido hoy, así que no exigen
      // trabajo nuevo y sí impiden la regresión.
      //
      // Dos ausencias deliberadas:
      //
      //  · period-close.ts NO lleva umbral. Mide 8% aquí y el número es
      //    engañoso: sus pruebas son de INTEGRACIÓN y esta corrida las
      //    excluye. Ponerle un umbral en el proyecto unitario obligaría a
      //    duplicar con mocks lo que ya se prueba contra Postgres real.
      //  · sequence.ts está en 69% contra un objetivo de 100%. Se deja el
      //    trinquete en lo medido en vez de fingir que el objetivo se
      //    cumple; subirlo es trabajo con nombre, no un número en un
      //    archivo de configuración.
      // ============================================================
      thresholds: {
        'src/services/accounting/posting.ts': {
          statements: 99, branches: 95, functions: 100, lines: 99,
        },
        'src/services/accounting/validation.ts': {
          statements: 90, branches: 77, functions: 100, lines: 90,
        },
        'src/services/accounting/ar-ap-posting.ts': {
          statements: 96, branches: 74, functions: 100, lines: 96,
        },
        'src/utils/sequence.ts': {
          statements: 69, branches: 100, functions: 75, lines: 69,
        },
      },
    },
  },
});
