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
      // La carpeta de informes entra desde G1a: report-service.ts es el único
      // punto por el que pasan las tres superficies que publican un estado
      // firmado, y medía CERO aquí porque nadie la había incluido.
      // J0.1 · `src/services/jurisdiction/` entra el día que nace, y no es
      // cosmética: el conmutador de jurisdicción se LLEVÓ líneas que sí se
      // medían —vivían en `services/accounting/pais-contable.ts`— y sin esta
      // línea el refactor habría sacado del conjunto medido el código que
      // decide qué catálogo fiscal recibe una entidad. Es una ADICIÓN al
      // include, no una bajada de umbral.
      //
      // Y NACE CON SU TRINQUETE, en 100/100/100/100, que es donde su tramo lo
      // dejó. Ponerlo exige mover TRES piezas a la vez —el umbral de aquí, la
      // entrada de SUELO_COBERTURA_UNITARIA en src/plan/criterios.ts, y el
      // conteo a mano del ataque 3c de tests/integration/s4a-ataque.int.spec.ts,
      // que verifica cuántos archivos tienen umbral propio—; moverlas por
      // separado pone en rojo el ataque. Se mueven juntas: un módulo que decide
      // qué catálogo fiscal recibe una entidad no empieza a medirse el día que
      // alguien se acuerde.
      include: [
        'src/services/accounting/**',
        'src/services/jurisdiction/**',
        'src/services/reporting/**',
        'src/utils/sequence.ts',
        // O1 · las dos puertas por donde entra un XML del SAT. Se nombran una
        // a una en vez de abrir `src/services/sat/**` entero: lo que hace
        // falta medir es el lector que decide si un peso entra, no los
        // generadores de al lado, y un `include` más ancho movería la cifra
        // global de archivos que este tramo no tocó.
        'src/services/sat/anexo24/catalog-reader.ts',
        'src/services/sat/anexo24/balance-reader.ts',
      ],
      // ============================================================
      // UMBRALES POR ARCHIVO, FIJADOS DONDE YA ESTÁN GANADOS
      //
      // Un umbral global es un promedio: deja que la cobertura de una pieza
      // crítica caiga mientras otra sube. Éstos son trinquetes por archivo —
      // están puestos justo debajo de lo medido hoy, así que no exigen
      // trabajo nuevo y sí impiden la regresión.
      //
      // Tres ausencias deliberadas:
      //
      //  · period-close.ts NO lleva umbral. Mide 14.6% aquí y el número es
      //    engañoso: sus pruebas son de INTEGRACIÓN y esta corrida las
      //    excluye. Ponerle un umbral en el proyecto unitario obligaría a
      //    duplicar con mocks lo que ya se prueba contra Postgres real.
      //  · ledger-checks.ts tampoco, y por lo mismo: 4.05% aquí, y sus
      //    chequeos sólo dicen algo contra un mayor de verdad. Un trinquete
      //    puesto en 4 no protege nada; uno puesto en 80 se paga con mocks
      //    que fingen el mayor, que es lo contrario de lo que G1a arregló.
      //  · sequence.ts está en 66% contra un objetivo de 100%. Se deja el
      //    trinquete en lo medido en vez de fingir que el objetivo se
      //    cumple; subirlo es trabajo con nombre, no un número en un
      //    archivo de configuración.
      //
      // LO QUE UN UMBRAL AQUÍ SÍ Y NO PROMETE (G1a)
      //
      // report-service.ts exhibía 88% sin tocar Postgres ni una vez: su banco
      // de pruebas mockea `query`, y una de sus filas RECOMPONE la resta que
      // la consulta declara. Con ese arnés, invertir el signo de las sumas
      // firmadas pasaba las 3 500 unitarias en verde. El umbral de abajo es un
      // trinquete sobre ESA suite —impide que encoja— y no una promesa de
      // conducta; la conducta la sostiene
      // tests/integration/g1a-cifras-que-se-firman.int.spec.ts, que lee las
      // mismas funciones contra un ejercicio cerrado de verdad. Son dos
      // garantías distintas y ninguna sustituye a la otra.
      //
      // LA REGLA CAMBIÓ DE MILÍMETROS (vitest 4)
      //
      // El proveedor v8 de vitest 1 remapeaba los rangos de V8 por líneas y
      // daba por ejecutado todo lo que el módulo importaba; desde vitest 2 el
      // remapeo es por nodo del AST y ya no infla. Con la MISMA suite —143
      // archivos, ni una prueba menos— chart-seed.ts pasó de 68% a 6% y
      // sequence.ts de 79% a 66%: no se perdió cobertura, se dejó de contar
      // la que no existía. Por eso el trinquete de sequence.ts se reexpresa
      // sobre la regla nueva en vez de sostener un número que medía otra cosa.
      //
      // En posting.ts y ar-ap-posting.ts el hueco que la regla nueva destapó
      // sí se cerró con pruebas (el fallo de atestación, la cuenta bancaria
      // vinculada, el rol sin mapear y las dos puertas de idempotencia), y por
      // eso sus umbrales SUBEN.
      // ============================================================
      thresholds: {
        'src/services/accounting/posting.ts': {
          statements: 99, branches: 95, functions: 100, lines: 99,
        },
        'src/services/accounting/validation.ts': {
          statements: 90, branches: 77, functions: 100, lines: 90,
        },
        'src/services/accounting/ar-ap-posting.ts': {
          statements: 99, branches: 89, functions: 100, lines: 99,
        },
        'src/utils/sequence.ts': {
          statements: 68, branches: 100, functions: 75, lines: 66,
        },
        // Medidos hoy: 88.23 / 76.29 / 95.83 / 88.88.
        'src/services/reporting/report-service.ts': {
          statements: 88, branches: 76, functions: 95, lines: 88,
        },
        // La capa compartida del criterio de cierre nace con su trinquete:
        // es la pieza por la que pasan las tres superficies, y el día que
        // alguien la bifurque otra vez el número lo dirá antes que nadie.
        // Medidos hoy: 100 / 96 / 100 / 100.
        'src/services/jurisdiction/jurisdiction.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        // J0.2 · El lector de la ley y su semilla, con el mismo criterio: un
        // archivo que decide qué tasa se aplica —y otro que decide qué dice
        // la ley que se guardó— no empieza a medirse el día que alguien se
        // acuerde. Medidos hoy: 100 / 100 / 100 / 100 en los dos, que es donde
        // los dejó su tramo.
        //
        // Entran aquí SIN renglón en SUELO_COBERTURA_UNITARIA, y conviene
        // decir qué compra y qué no: `contraSuelo` exige a los archivos DEL
        // SUELO que no bajen, y a los demás sólo que ninguna métrica esté en
        // cero. Así que hoy estos dos umbrales los sostiene la corrida de
        // cobertura —que se pone roja si bajan— pero no el trinquete del
        // tablero: alguien podría bajarlos EDITANDO ESTA LÍNEA sin que ningún
        // criterio se moviera. Cerrarlo es añadirles su renglón en
        // src/plan/criterios.ts, que es de quien cierra el criterio del tramo.
        'src/services/jurisdiction/legal-parameters.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        'src/services/jurisdiction/legal-parameters-seed.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        'src/services/reporting/criterio-cierre.ts': {
          statements: 100, branches: 95, functions: 100, lines: 100,
        },
        // El criterio de cuentas archivadas (T13): decide qué cuenta entra en
        // un informe, así que su suelo es el más alto que hay.
        'src/services/reporting/criterio-archivadas.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        // ============================================================
        // O1 · LAS SEIS PIEZAS POR LAS QUE ENTRA UNA CONTABILIDAD ENTERA
        //
        // Un archivo nuevo sin renglón aquí puede perder cobertura en
        // cualquier commit posterior sin que ninguna compuerta se mueva, y
        // éstos son los que deciden si un peso del sistema viejo entra, con
        // qué signo y bajo qué padre. Nacen medidos y con el suelo puesto
        // donde ya está ganado.
        // ============================================================
        // Medidos hoy: 100 / 100 / 100 / 100 en los dos.
        'src/services/accounting/opening-balance.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        'src/services/accounting/opening-balance-check.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        // Medidos hoy: 99.45 / 94.61 / 100 / 99.41.
        'src/services/accounting/sat-chart-import.ts': {
          statements: 99, branches: 94, functions: 100, lines: 99,
        },
        // Medidos hoy: 97.36 / 97.50 / 100 / 97.22. Lo que falta es la rama
        // `sin_regla`, hoy inalcanzable: una prueba recorre los 141 rubros
        // del c_CodAgrup y exige que ninguno caiga en ella.
        'src/services/accounting/sat-agrupador-account-type.ts': {
          statements: 97, branches: 97, functions: 100, lines: 97,
        },
        // Los dos lectores del XML. Medidos hoy: 98.93 / 88.88 / 100 / 100 y
        // 98.80 / 81.05 / 100 / 100. Las ramas que faltan son las del
        // analizador —atributos ausentes en combinaciones que el archivo del
        // SAT no produce— y se declaran en el suelo tal como están, no
        // redondeadas hacia arriba.
        'src/services/sat/anexo24/balance-reader.ts': {
          statements: 98, branches: 88, functions: 100, lines: 100,
        },
        'src/services/sat/anexo24/catalog-reader.ts': {
          statements: 98, branches: 81, functions: 100, lines: 100,
        },
      },
    },
  },
});
