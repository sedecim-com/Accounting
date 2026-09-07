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
    // ============================================================
    // LA COBERTURA QUE ESTA SUITE SÍ MIDE (S4a)
    //
    // Durante toda la vida del proyecto este archivo NO declaró cobertura, y
    // la consecuencia era exactamente la contraria a la que parece: las 984
    // pruebas que ejercitan el dinero contra un Postgres de verdad no contaban
    // para ninguna medida, y las decisiones sobre umbrales se tomaban mirando
    // sólo la suite unitaria — la que mockea `query`.
    //
    // Se ve en los dos archivos que vitest.config.ts se niega, con razón, a
    // ratchetear: period-close.ts mide 14.6% en unitarias y 90.15% aquí;
    // ledger-checks.ts, 4.05% allá y 90.54% aquí. No era cobertura ausente:
    // era cobertura que nadie contaba. Ponerles un umbral en el proyecto
    // unitario habría obligado a duplicar con mocks lo que ya se prueba contra
    // Postgres; ponérselo AQUÍ no cuesta una prueba nueva.
    //
    // LOS NÚMEROS SALEN DE UNA MEDICIÓN, NO DE UNA ASPIRACIÓN. Corrida
    // completa del 2026-09-02 (75 archivos, 984 pruebas, todas en verde):
    // global 79.67 / 70.32 / 84.61 / 81.04 sobre estos dos árboles. Cada
    // umbral de abajo es el ENTERO INFERIOR de lo medido en ese archivo: un
    // umbral por debajo de lo alcanzado no protege nada, y uno por encima es
    // trabajo pendiente disfrazado de configuración.
    //
    // POR QUÉ NO HAY UMBRAL GLOBAL, ni siquiera aquí: un global es un promedio
    // y deja caer una pieza crítica mientras otra sube (el mismo argumento que
    // vitest.config.ts hace desde G1a). Los umbrales son por archivo y sólo
    // sobre los que sostienen dinero o cierre.
    //
    // EL DIRECTORIO NO PUEDE SER `coverage/`, y no es cosmética: la corrida
    // unitaria LIMPIA ese directorio al arrancar, así que una integración
    // midiendo dentro de él muere con «Something removed the coverage
    // directory» en cuanto las dos corren a la vez. Se comprobó en esta
    // máquina con dos sesiones en paralelo.
    // ============================================================
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage-integration',
      include: [
        'src/services/accounting/**',
        'src/services/reporting/**',
      ],
      thresholds: {
        // Los dos que sólo esta suite puede medir: aquí nacen sus trinquetes.
        // Medidos: 90.15 / 81.05 / 96.77 / 89.69.
        'src/services/accounting/period-close.ts': {
          statements: 90, branches: 81, functions: 96, lines: 89,
        },
        // Medidos: 90.54 / 86.84 / 75 / 92.64.
        'src/services/accounting/ledger-checks.ts': {
          statements: 90, branches: 86, functions: 75, lines: 92,
        },
        // Las tres puertas al mayor, medidas contra un mayor de verdad. Sus
        // umbrales unitarios son más altos y NO se contradicen con éstos:
        // miden suites distintas, y ninguna sustituye a la otra.
        // Medidos: 91.9 / 86.61 / 96 / 91.35.
        'src/services/accounting/posting.ts': {
          statements: 91, branches: 86, functions: 96, lines: 91,
        },
        // Medidos: 87.36 / 75.72 / 96.55 / 91.49.
        'src/services/accounting/ar-ap-posting.ts': {
          statements: 87, branches: 75, functions: 96, lines: 91,
        },
        // Medidos: 86.99 / 78.16 / 100 / 88.49.
        'src/services/accounting/validation.ts': {
          statements: 86, branches: 78, functions: 100, lines: 88,
        },
        // El IVA de flujo: es el módulo que decide cuándo un impuesto se
        // vuelve exigible, y sus pruebas son casi todas de integración.
        // Medidos: 96.52 / 84.15 / 100 / 98.98.
        'src/services/accounting/iva-cash-basis.ts': {
          statements: 96, branches: 84, functions: 100, lines: 98,
        },
        // Las cifras que se firman. El 88% unitario de report-service se gana
        // con `query` mockeado —G1a documentó que con ese arnés invertir el
        // signo de las sumas pasaba en verde—; ESTE 84% se gana leyendo un
        // ejercicio cerrado de verdad. Por eso el número menor vale más.
        // Medidos: 84.35 / 75 / 77.96 / 86.84.
        'src/services/reporting/report-service.ts': {
          statements: 84, branches: 75, functions: 77, lines: 86,
        },
        // Medidos: 91.89 / 80 / 85.71 / 91.66.
        'src/services/reporting/criterio-cierre.ts': {
          statements: 91, branches: 80, functions: 85, lines: 91,
        },
        // Medidos: 94.91 / 89.65 / 96.42 / 95.28.
        'src/services/reporting/cash-flow-service.ts': {
          statements: 94, branches: 89, functions: 96, lines: 95,
        },
      },
    },
  },
});
