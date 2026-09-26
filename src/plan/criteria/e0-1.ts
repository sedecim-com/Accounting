import * as fs from 'node:fs';
import {
  codigoDe,
  contadoresAnualesSembrados,
  contraSuelo,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  METRICAS,
  noEvaluable,
  ok,
  rutaDe,
  sinResiduoDelSecreto,
  stepRuns,
  SUELO_COBERTURA_INTEGRACION,
  SUELO_COBERTURA_UNITARIA,
  umbralesDeclarados,
} from './shared.js';

// ============================================================
// THE E0.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E0_1: Criterio[] = [

  {
    paquete: 'E0.1',
    id: 'separate-unit-integration-suites',
    enunciado: 'Los proyectos unitario y de integración están separados',
    mutantes: [
      {
        archivo: 'vitest.config.ts',
        de: "    exclude: ['tests/integration/**',",
        a: "    exclude: [",
        porque:
          'la suite unitaria vuelve a recoger las pruebas de integración: correrían sin base, fallarían por la razón equivocada, y la separación existiría sólo como dos archivos',
      },
      {
        archivo: 'vitest.integration.config.ts',
        de: "    include: ['tests/integration/**/*.int.spec.ts'],",
        a: "    include: ['tests/nada/**/*.int.spec.ts'],",
        porque:
          'la suite de integración deja de apuntar a las pruebas que le tocan y pasa a correr CERO: verde perfecto, ninguna medida — el segundo archivo sigue ahí',
      },
    ],
    evaluar: () => {
      // T2 · VACUIDAD. Esto preguntaba `existe(a) && existe(b)`, y con eso dos
      // archivos VACÍOS lo ponían en verde: la prueba de vacuidad lo encontró
      // diciendo «dos configuraciones» sobre un árbol donde no había ninguna
      // configuración. Lo que se compró aquí no fueron dos archivos, fue el
      // reparto: la suite sin base no recoge las pruebas con base, y la suite
      // con base apunta a ellas. Eso es lo que se mide.
      if (!existe('vitest.config.ts') || !existe('vitest.integration.config.ts')) {
        return falla('falta la separación entre pruebas con base y sin base');
      }
      const unitCfg = codigoDe('vitest.config.ts');
      const integrationCfg = codigoDe('vitest.integration.config.ts');
      if (!/exclude:\s*\[[^\]]*'tests\/integration\/\*\*'/.test(unitCfg)) {
        return falla(
          'la suite unitaria no excluye tests/integration: las pruebas con base correrían sin base y ' +
            'fallarían por la razón equivocada, que es como se acaba desactivando la suite entera'
        );
      }
      return /include:\s*\[[^\]]*'tests\/integration\/.*\.int\.spec\.ts'/.test(integrationCfg)
        ? ok('dos configuraciones que se reparten el trabajo: la unitaria excluye lo que la de integración incluye')
        : falla('la suite de integración no apunta a tests/integration: correría cero pruebas y saldría verde');
    },
  },
  {
    paquete: 'E0.1',
    id: 'per-file-unit-coverage-ratchet',
    enunciado: 'La cobertura del motor contable tiene trinquete por archivo',
    evaluar: () => {
      // S4a: este criterio CONTABA LLAVES —cuántas entradas `'src/…ts':` hay—
      // y con esa vara los tres umbrales puestos en CERO lo dejaban en verde.
      // Ahora lee los VALORES contra SUELO_COBERTURA_UNITARIA; el porqué de
      // esa forma de vara, y lo que no compra, está sobre la tabla.
      const c = codigoDe('vitest.config.ts');
      if (!/thresholds/.test(c)) return falla('vitest.config.ts no define umbrales de cobertura');

      const problemas = contraSuelo(c, SUELO_COBERTURA_UNITARIA);
      if (problemas.length > 0) return falla(problemas.join('; '));

      const declarados = umbralesDeclarados(c);
      const comprobados = Object.keys(SUELO_COBERTURA_UNITARIA).length * METRICAS.length;
      return ok(
        `${declarados.size} archivos con umbral propio; ${comprobados} valores comprobados contra el suelo y ninguno por debajo`
      );
    },
    mutantes: [
      {
        archivo: 'vitest.config.ts',
        de: 'statements: 99, branches: 95, functions: 100, lines: 99,',
        a: 'statements: 0, branches: 0, functions: 0, lines: 0,',
        porque:
          'EL ESCAPE QUE ESTE TRAMO VINO A CERRAR: los umbrales en cero dejan las llaves en su sitio, ' +
          'así que el criterio que contaba llaves seguía en verde mientras el trinquete ya no apretaba nada',
      },
      {
        archivo: 'vitest.config.ts',
        de: "'src/services/reporting/criterio-cierre.ts': {",
        a: "'src/services/reporting/otro-archivo.ts': {",
        porque:
          'el trinquete se retira por RENOMBRE en vez de por rebaja —el conteo de llaves no se mueve— ' +
          'y la pieza por la que pasan las tres superficies de cierre se queda sin umbral',
      },
      {
        archivo: 'vitest.config.ts',
        de: "        'src/services/reporting/**',\n",
        a: '',
        porque:
          'el umbral sobrevive pero su archivo sale de coverage.include: un umbral sobre algo que no se ' +
          'mide no exige nada, y es la forma silenciosa de apagarlo',
      },
    ],
  },
  {
    paquete: 'E0.1',
    id: 'integration-coverage-enforced-in-ci',
    enunciado: 'La suite de integración declara su cobertura y la ejerce en CI',
    evaluar: () => {
      // POR QUÉ NACE ESTE CRITERIO (S4a). vitest.integration.config.ts no tenía
      // bloque `coverage` en toda la vida del proyecto: 984 pruebas contra un
      // Postgres de verdad —las que ejercitan el dinero— no contaban para
      // ninguna medida. Se veía en los dos archivos que el proyecto unitario se
      // niega, con razón, a ratchetear: period-close.ts medía 14.6% allá y mide
      // 90.15% aquí; ledger-checks.ts, 4.05% y 90.54%. No era cobertura que
      // faltara: era cobertura que nadie contaba.
      if (!existe('vitest.integration.config.ts')) {
        return falla('no hay configuración de integración: no hay nada que medir');
      }
      const c = codigoDe('vitest.integration.config.ts');
      if (!/coverage:/.test(c) || !/thresholds/.test(c)) {
        return falla(
          'la suite de integración no declara cobertura con umbrales: las pruebas contra Postgres no cuentan para ninguna medida'
        );
      }

      const problemas = contraSuelo(c, SUELO_COBERTURA_INTEGRACION);

      // Y CORRE. Un umbral que nadie ejecuta es la misma clase de mentira que
      // el job `restauracion` vino a tapar un piso más arriba: vitest sólo
      // aplica `thresholds` cuando se le pide medir, así que sin --coverage en
      // la línea de CI esta configuración diría la verdad sobre sí misma sin
      // que nadie la corriera nunca.
      const ci = existe('.github/workflows/ci.yml') ? crudoDe('.github/workflows/ci.yml') : '';
      // Por el PASO y no por la cadena (T2): `test:integration…--coverage`
      // casaba dentro del comentario de arriba, que cita el comando entero.
      if (!stepRuns(ci, 'npm run test:integration -- --coverage')) {
        return falla(
          'ci.yml corre la suite de integración SIN --coverage: los umbrales declarados no se aplican en ninguna parte' +
            (problemas.length > 0 ? `; además: ${problemas.join('; ')}` : '')
        );
      }

      if (problemas.length > 0) return falla(problemas.join('; '));

      const archivos = Object.keys(SUELO_COBERTURA_INTEGRACION).length;
      return ok(
        `${archivos} archivos con umbral medido contra Postgres, y la CI corre la suite con --coverage`
      );
    },
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: 'npm run test:integration -- --coverage',
        a: 'npm run test:integration',
        porque:
          'los umbrales de integración quedan escritos y nadie los ejecuta: la configuración diría la ' +
          'verdad sobre sí misma sin correr jamás, que es el defecto que el job de restauración ya costó una vez',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npm run test:integration -- --coverage',
        a: '      # - run: npm run test:integration -- --coverage',
        porque:
          'la puerta se apaga comentándola, y el ancla de subcadena de antes de T2 la encontraba dentro del comentario de este mismo criterio',
      },
      {
        archivo: 'vitest.integration.config.ts',
        de: 'statements: 90, branches: 81, functions: 96, lines: 89,',
        a: 'statements: 0, branches: 0, functions: 0, lines: 0,',
        porque:
          'el umbral del cierre de periodo —el archivo que SÓLO esta suite puede medir— se pone en cero, ' +
          'que es la rebaja invisible que el conteo de llaves nunca vio',
      },
    ],
  },
  {
    paquete: 'E0.1',
    id: 'ephemeral-integration-database',
    enunciado: 'La suite de integración usa una base efímera, no la de desarrollo',
    evaluar: () => {
      if (!existe('tests/integration/global-setup.ts')) return falla('no hay global-setup de integración');
      const s = codigoDe('tests/integration/global-setup.ts');
      return /CREATE DATABASE/i.test(s) && /DROP DATABASE/i.test(s)
        ? ok('crea y destruye su propia base por corrida')
        : falla('el setup no crea ni destruye una base propia');
    },
  },
  {
    paquete: 'E0.1',
    id: 'period-seal-entry-count-matches',
    enunciado: 'Ningún sello de periodo declara menos asientos de los que su periodo cerrado tiene',
    necesita: 'base-de-datos',
    evaluar: async () => {
      // POR QUÉ ESTE CRITERIO ES LA MITAD DE LO QUE FUE.
      //
      // La primera versión afirmaba además que «todo asiento posteado está en
      // la cadena donde el anclaje está activo». Eso no se puede medir sin un
      // inquilino anclado, así que sobre la base recién creada de CI salía NO
      // EVALUABLE — y `estadoDe` trata un criterio inevaluable como impedimento
      // para dar por cerrado el paquete, con razón: quien depende de E0.1 no
      // distingue «está mal» de «nadie sabe si está bien». El trinquete puso la
      // CI en rojo y tenía razón; lo que no encajaba era el criterio.
      //
      // Se parte, y aquí queda la mitad decidible sin datos previos: un sello
      // que declara menos de lo que su periodo cerrado tiene posteado es falso
      // con datos o sin ellos, y cuando no hay sellos no hay nada que
      // contradiga la afirmación. La otra mitad vive donde se puede medir de
      // verdad —tests/integration/sello-periodo.int.spec.ts, que siembra el
      // anclaje y comprueba que postear un borrador entra en la cadena y que
      // `commitPeriod` se niega ante una laguna—.
      //
      // Este criterio es, entonces, un detector de regresión sobre datos
      // reales, no la prueba del paquete. Por eso su detalle SIEMPRE dice
      // cuántos sellos llegó a inspeccionar: un verde que no diga eso sería
      // verde por no mirar, que es justo lo que el sprint persigue.
      const { query } = await import('../../database/connection.js');

      let alcance = 'todos los inquilinos';
      try {
        const rol = await query<{ ve: boolean; rol: string }>(
          `SELECT current_user AS rol,
                  COALESCE(rolsuper OR rolbypassrls, false) AS ve
             FROM pg_roles WHERE rolname = current_user`
        );
        if (rol.rows[0] && !rol.rows[0].ve) {
          // Las tablas llevan RLS forzado: sin contexto de inquilino este rol
          // ve cero filas. No es motivo para declararse inevaluable —no hay
          // nada que contradiga la afirmación— pero sí para decirlo.
          alcance = `lo visible para "${rol.rows[0].rol}", que está sujeto a RLS`;
        }
      } catch {
        /* si pg_roles no se deja leer, lo dirá el catch de abajo */
      }

      let sellos;
      try {
        sellos = await query<{ period_id: string; declarados: number; posteados: string }>(
          // Sólo periodos CERRADOS. En uno abierto, un sello que cubre menos
          // no es una mentira sino una foto con fecha: se selló, y después
          // entraron asientos. El endpoint público sirve `committedAt` al
          // lado de la cifra, así que esa diferencia es legible.
          `SELECT pc.period_id,
                  pc.entry_count AS declarados,
                  (SELECT count(*) FROM journal_entries je
                    WHERE je.fiscal_period_id = pc.period_id
                      AND je.entity_id = pc.entity_id
                      AND je.status = 'posted')::text AS posteados
             FROM period_commitments pc
             JOIN fiscal_periods fp ON fp.id = pc.period_id
            WHERE fp.status IN ('soft_close', 'hard_close', 'locked')`
        );
      } catch (e) {
        const porque = (e as Error).message.slice(0, 60) || 'sin detalle';
        return noEvaluable(`no hay base de datos accesible para medirlo (${porque})`);
      }

      const mienten = sellos.rows.filter((x) => x.declarados !== Number(x.posteados));
      if (mienten.length > 0) {
        const m = mienten[0];
        return falla(
          `${mienten.length} sello(s) declaran menos asientos de los que su periodo tiene ` +
            `posteados — p. ej. el periodo ${m.period_id.slice(0, 8)} sella ${m.declarados} ` +
            `de ${m.posteados}. Esa cifra se publica como la cuenta del periodo.`
        );
      }
      return ok(
        sellos.rows.length === 0
          ? `sin sellos de periodos cerrados que revisar en ${alcance}`
          : `${sellos.rows.length} sello(s) de periodos cerrados coinciden con su periodo (${alcance})`
      );
    },
  },
  {
    paquete: 'E0.1',
    id: 'commitment-hides-its-value',
    enunciado: 'El compromiso no persiste el valor que promete ocultar',
    evaluar: async () => {
      // S1 (E1.4-a rescatada): el range proof placeholder incluía
      // _test_value y _test_bf bajo el comentario «DO NOT store the value in
      // a real proof», y el orquestador lo persistía entero — el compromiso
      // que vende «prueba el rango SIN revelar el importe» llevaba dentro el
      // importe y el factor para abrirlo. El generador ya no las escribe y
      // la 040 purgó las filas; esto vigila que no vuelvan.
      const fuga = dondeAparece(/_test_value|_test_bf/, ['src'], true);
      if (fuga.length > 0) {
        return falla(`el valor volvió al blob del compromiso: ${fuga.join(', ')}`);
      }
      if (!existe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql')) {
        return falla('la migración de purga (040) desapareció: las filas históricas retendrían la fuga');
      }
      const purga = crudoDe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql');
      if (!/range_proof\s*=\s*NULL/.test(purga) || !/zkverify_proof\s*=\s*NULL/.test(purga)) {
        return falla('la 040 no purga los dos blobs (range_proof y zkverify_proof)');
      }
      // S3 · DE TEXTO A EFECTO. Este criterio leía el .sql y daba verde por
      // que la purga ESTUVIERA ESCRITA — sin poder distinguir «corrió» de «no
      // tocó nada». Y no tocó nada: bajo FORCE RLS el migrador afectaba cero
      // filas en silencio. Un criterio que no distingue esas dos cosas es
      // exactamente el falso verde que esta casa persigue, así que ahora se
      // le pregunta A LA BASE.
      return await sinResiduoDelSecreto();
    },
    necesita: 'base-de-datos',
  },
  {
    paquete: 'E0.1',
    id: 'posted-journal-entries-immutable',
    enunciado: 'Un asiento posteado no admite UPDATE ni DELETE fuera de su lista blanca',
    evaluar: () => {
      // R1: la 033 blindó la bitácora y el mayor —lo que la bitácora
      // protege— seguía físicamente reescribible: un UPDATE balanceado sobre
      // una línea posteada no viola ningún CHECK y desalinea los saldos sin
      // rastro. La 041 pone el disparador condicional (lista blanca de
      // metadatos por resta de JSONB: una columna nueva nace protegida) en
      // las DOS tablas, más el candado de TRUNCATE.
      const m = 'src/database/migrations/041_el_mayor_inviolable.sql';
      if (!existe(m)) return falla('la 041 desapareció: el mayor vuelve a ser reescribible');
      const sql = crudoDe(m);
      const checks: Array<[boolean, string]> = [
        [/ON journal_entries\b[\s\S]{0,80}FOR EACH ROW/.test(sql) || /BEFORE UPDATE OR DELETE ON journal_entries/.test(sql), 'falta el disparador de journal_entries'],
        [/BEFORE UPDATE OR DELETE ON journal_entry_lines/.test(sql), 'falta el disparador de journal_entry_lines'],
        [(sql.match(/to_jsonb\(NEW\)\s*-\s*permitidas/g) ?? []).length >= 2, 'la comparación por resta de JSONB falta en alguna de las DOS funciones: una columna nueva nacería expuesta (la primera mutación de este criterio se escapó por contar una sola)'],
        [/BEFORE TRUNCATE ON journal_entries/.test(sql) && /BEFORE TRUNCATE ON journal_entry_lines/.test(sql), 'falta el candado de TRUNCATE'],
        [(sql.match(/RAISE EXCEPTION/g) ?? []).length >= 3, 'los disparadores no rechazan'],
      ];
      const roto = checks.find(([pasa]) => !pasa);
      return roto ? falla(roto[1]) : ok('el mayor posteado sólo admite su lista blanca de metadatos, en las dos tablas');
    },
  },
  {
    paquete: 'E0.1',
    id: 'ledger-balances-match-posted-lines',
    enunciado: 'Los saldos materializados se verifican contra las líneas, y la deriva es fail',
    evaluar: () => {
      // R1: account_balances es tabla load-bearing del cierre y nada la
      // comprobaba contra Σ de líneas posteadas; doctor la vigila y —a
      // diferencia de la capacidad huérfana, informativa a propósito— aquí
      // fallar es 'fail': un mayor que no cuadra con sus líneas no opera.
      const d = codigoDe('src/ai/doctor-service.ts');
      if (!/checkLedgerIntegrity/.test(d)) {
        return falla('doctor perdió el chequeo de integridad del mayor');
      }
      const i = d.indexOf('function checkLedgerIntegrity');
      const body = d.slice(i, i + 3500);
      // «POR AMBOS LADOS» SE COMPRUEBA POR AMBOS LADOS (S4, mutante 4/6).
      //
      // Esto era un `/status = 'posted'/` suelto sobre el cuerpo entero, y el
      // enunciado ya prometía los dos. Con una sola aparición bastando, quitarle
      // el filtro a CUALQUIERA de las dos consultas dejaba el criterio verde: el
      // mutante que este tramo manda sembrar salía vivo, y el criterio está EN
      // EL PISO, o sea protegiendo algo que no miraba.
      //
      // Perderlo en la primera mete un asiento en BORRADOR en la Σ de líneas, y
      // `doctor` acusaría una deriva del mayor que no existe. En la segunda, al
      // revés: dejaría de contar los posteados sin rastro de auditoría.
      if (!/FULL OUTER JOIN/i.test(body)) {
        return falla('el chequeo no compara account_balances contra Σ de líneas por deriva');
      }
      const FROM_LINES = /FROM journal_entry_lines jel[\s\S]{0,200}?status\s*=\s*'posted'[\s\S]{0,120}?GROUP BY/;
      if (!FROM_LINES.test(body)) {
        return falla(
          'la Σ de líneas dejó de filtrar por posteadas: un asiento en BORRADOR entraría en el total ' +
            'y doctor acusaría una deriva del mayor que no existe'
        );
      }
      const FROM_ENTRY_TRAIL = /FROM journal_entries je[\s\S]{0,80}?status\s*=\s*'posted'[\s\S]{0,300}?action\s*=\s*'post'/;
      if (!FROM_ENTRY_TRAIL.test(body)) {
        return falla(
          'el conteo de asientos sin rastro dejó de acotarse a los posteados: contaría borradores, ' +
            'que no tienen por qué llevar renglón de auditoría de posteo'
        );
      }
      if (!/level:\s*'fail'/.test(body)) {
        return falla('la deriva del mayor quedó degradada a warn: un número falso con aspecto de número');
      }
      return /checks\.push\(await checkLedgerIntegrity\(\)\)/.test(d)
        ? ok('doctor verifica saldos = Σ líneas y posteados con rastro, y la deriva es fail')
        : falla('el chequeo existe y runDoctor no lo corre');
    },
    // S4 · MUTANTE 4/6 y su gemelo: son DOS consultas y cada una necesita el
    // suyo, porque una sola ancla dejaba viva a la otra.
    mutantes: [
      {
        archivo: 'src/ai/doctor-service.ts',
        de: "          WHERE je.status = 'posted'",
        a: "          WHERE je.status IS NOT NULL",
        porque:
          'la Σ de líneas deja de filtrar por posteadas: un borrador entra en el total y doctor acusa ' +
          'una deriva del mayor que no existe',
      },
      {
        // EL ANCLA LLEVA LA LÍNEA DE ARRIBA, Y NO ES ADORNO. Con sólo
        // `      WHERE je.status = 'posted'` (seis espacios) este espejo no
        // mordía lo que dice: esa cadena está CONTENIDA en la línea de la Σ de
        // líneas —que lleva diez espacios y va antes en el archivo— y el arnés
        // sustituye la PRIMERA aparición. Los dos mutantes reescribían la misma
        // consulta, el segundo moría con el mensaje del primero, y el filtro
        // del conteo sin rastro se quedaba sin espejo justo en el commit que
        // vino a dárselo. `FROM journal_entries je` sólo aparece aquí.
        archivo: 'src/ai/doctor-service.ts',
        de: "       FROM journal_entries je\n      WHERE je.status = 'posted'",
        a: "       FROM journal_entries je\n      WHERE je.status <> 'void'",
        porque:
          'el conteo de asientos sin rastro deja de acotarse a los posteados: cuenta borradores, que ' +
          'no tienen por qué llevar renglón de auditoría de posteo',
      },
    ],
  },
  {
    paquete: 'E0.1',
    id: 'posting-and-close-lock-period',
    enunciado: 'El posteo y el cierre no se cruzan: el candado del periodo vive en ambas transacciones',
    mutantes: [
      {
        archivo: 'src/services/accounting/posting.ts',
        de: 'bloquearPeriodoParaPostear(client',
        a: 'bloquearPeriodoParaPostearSin(client',
        porque: 'una de las dos transacciones suelta el candado: el conteo ×2 debe acusarlo',
      },
    ],
    evaluar: () => {
      // R1 (TOCTOU): la validación leía el periodo FUERA de la transacción
      // del posteo, y el checklist del cierre suave se fotografiaba FUERA de
      // la suya — un posteo en vuelo podía aterrizar en un periodo que
      // cerraba, con un checklist que no lo contaba. FOR SHARE (posteo) ×
      // FOR UPDATE (cierre) sobre la misma fila cierran la carrera.
      const p = codigoDe('src/services/accounting/posting.ts');
      const consumos = (p.match(/bloquearPeriodoParaPostear\(client/g) ?? []).length;
      if (!/FOR SHARE/.test(p) || consumos < 2) {
        return falla(
          `el posteo no toma el candado compartido del periodo en sus dos transacciones (consumos: ${consumos})`
        );
      }
      const c = codigoDe('src/services/accounting/period-close.ts');
      return /FOR UPDATE/.test(c) && /getPeriodCloseStatus\(periodId,\s*entityId,\s*client\)/.test(c)
        ? ok('FOR SHARE en el posteo (×2) y checklist bajo FOR UPDATE en el cierre suave')
        : falla('el cierre suave volvió a fotografiar el checklist fuera de su transacción');
    },
  },
  {
    paquete: 'E0.1',
    id: 'reporting-refresh-is-explicit-callable',
    enunciado: 'Ningún posteo paga el refresco de las vistas de reporte de todos',
    evaluar: () => {
      // R3 (decidido en el plan de cierre, ejecutado aquí): el trigger de la
      // 004 refrescaba DOS vistas globales —cross-join de todos los
      // inquilinos— dentro de cada transacción de posteo, serializando
      // posteos de inquilinos distintos entre sí. El orden de migraciones es
      // la verdad: el último acto sobre el trigger debe ser el DROP, y el
      // camino de reemplazo (refresh_reporting_views + report view sync +
      // detector de deriva) debe seguir vivo.
      const dir = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dir))
        .sort()
        .map((m) => crudoDe(dir, m))
        .join('\n');
      const ultimaCreacion = sql.lastIndexOf('CREATE TRIGGER trg_refresh_materialized_views');
      const ultimoDrop = sql.lastIndexOf('DROP TRIGGER IF EXISTS trg_refresh_materialized_views');
      if (ultimoDrop < 0 || ultimoDrop < ultimaCreacion) {
        return falla(
          'el trigger de refresco sigue vivo al final de la cadena de migraciones: cada posteo vuelve a pagar el reporte de todos'
        );
      }
      if (!/refresh_reporting_views/.test(sql)) {
        return falla('el refresco callable (031) desapareció: no queda camino de refresco');
      }
      return /refreshReportingViews/.test(codigoDe('src/cli/report-command.ts'))
        ? ok('el trigger cayó (042) y el refresco vive en el callable + report view sync + detector de deriva')
        : falla('el comando de refresco desapareció: las vistas sólo se refrescarían a mano por SQL');
    },
  },
  {
    paquete: 'E0.1',
    id: 'numbering-series-from-document-date',
    enunciado: 'La serie del folio la fija la fecha del documento, no el reloj',
    evaluar: async () => {
      // R3: «JE-2026-00042» insinuaba serie anual y el año lo ponía el
      // reloj, con un contador que jamás se reiniciaba — un asiento de
      // diciembre capturado en enero salía en la serie del año nuevo
      // continuando la cuenta del viejo. Decidido ANTES del primer cruce de
      // ejercicio con datos reales.
      const s = codigoDe('src/utils/sequence.ts');
      // El tramo de nextEntityNumber en concreto: la firma de añoDeDocumento
      // también dice `fecha: Date | string` y dio verde a la mutación que
      // volvía opcional la fecha del folio — anclar al símbolo equivocado es
      // el primo del regex que casa el import.
      const iNext = s.indexOf('export async function nextEntityNumber');
      const tramoNext = iNext >= 0 ? s.slice(iNext, s.indexOf('export', iNext + 10)) : '';
      if (!/fecha:\s*Date \| string/.test(tramoNext)) {
        return falla('nextEntityNumber ya no exige la fecha del documento: el reloj vuelve a foliar');
      }
      if (!/\$\{name\}_\$\{año\}/.test(s)) {
        return falla('la llave del contador perdió el año: la serie vuelve a ser una sola cuenta eterna');
      }
      if (!/^\s*const m = \/\^\(\\d\{4\}\)-\\d\{2\}-\\d\{2\}\/\.exec/m.test(s) && !/exec\(String\(fecha\)/.test(s)) {
        return falla('añoDeDocumento dejó de leer la cadena sin pasar por Date: el 31-dic retrocede de año al oeste de Greenwich');
      }
      const m = 'src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql';
      if (!existe(m)) return falla('la 043 desapareció: los contadores anuales arrancarían en 1 y colisionarían con lo emitido');
      const siembra = crudoDe(m);
      const inserts = (siembra.match(/INSERT INTO entity_sequences/g) ?? []).length;
      if (inserts < 5 || !/GREATEST/.test(siembra)) {
        return falla(`la siembra de la 043 no cubre las cinco series (${inserts}) o perdió el GREATEST`);
      }
      // S3 · DE TEXTO A EFECTO, por la misma razón que la 040: la siembra
      // estaba escrita y había sembrado CERO contadores, que es lo que
      // provocó la colisión de folios real. Ahora se comprueba el estado.
      return await contadoresAnualesSembrados();
    },
    necesita: 'base-de-datos',
  },

  {
    paquete: 'E0.1',
    id: 'materialized-refresh-sees-all-tenants',
    enunciado: 'El refresco de las materializadas ve el clúster entero, no el inquilino de la sesión',
    evaluar: () => {
      // R3, medido por el detector de deriva: con las 'm' reasignadas a
      // mnemosine_owner (NOBYPASSRLS, RLS forzada), REFRESH corría la
      // consulta definitoria con los lentes del inquilino casual de la
      // sesión — refresh_reporting_views() devolvía «hecho» y dejaba la
      // vista global VACÍA. El dueño de régimen de una materializada es
      // mnemosine_refresher: NOLOGIN (nadie se conecta con él) y BYPASSRLS
      // (el refresco ve a todos, que es su única función). Las planas
      // siguen con el operador: ésas SÍ re-corren su consulta al leerse.
      const prov = codigoDe('scripts/provision-roles.sql');
      const lineaRol = /CREATE ROLE mnemosine_refresher[^;]*;/.exec(prov)?.[0] ?? '';
      // (?<!NO)BYPASSRLS: «NOBYPASSRLS» contiene «BYPASSRLS» y un regex
      // ingenuo daría verde al mutante que apaga el bypass.
      if (!/NOLOGIN/.test(lineaRol) || !/(?<!NO)BYPASSRLS/.test(lineaRol)) {
        return falla('mnemosine_refresher perdió NOLOGIN o BYPASSRLS: el refresco vuelve a mirar por los lentes de un inquilino');
      }
      if (!/GRANT mnemosine_refresher TO mnemosine_owner/.test(prov)) {
        return falla('sin la membresía, refresh_reporting_views() (definer del operador) no pasa el chequeo de propiedad del REFRESH');
      }
      const pol = codigoDe('src/database/rls-policies.sql');
      if (!/'m' THEN 'mnemosine_refresher'/.test(pol) || !/ELSE 'mnemosine_owner'/.test(pol)) {
        return falla('el reconciliador dejó de repartir dueños por tipo: o la materializada refresca filtrada o la plana vuelve a leer sin RLS');
      }
      const ver = codigoDe('scripts/verify-isolation.sh');
      if (!/relkind = 'm'/.test(ver) || !/<> 'mnemosine_refresher'/.test(ver)) {
        return falla('verify-isolation dejó de comprobar el dueño de las materializadas');
      }
      return /CREATE ROLE mnemosine_refresher/.test(codigoDe('tests/integration/global-setup.ts'))
        ? ok('las «m» son del refresher (NOLOGIN+BYPASSRLS), las «v» del operador, y CI lo prueba de punta a punta')
        : falla('la base efímera de integración nace sin refresher: la suite dejaría de probar el refresco real');
    },
  },

  {
    paquete: 'E0.1',
    id: 'single-maker-checker-gate',
    enunciado: 'El maker-checker vive en el panel, en UN candado que todas las puertas al mayor atraviesan',
    mutantes: [
      {
        archivo: 'src/services/accounting/posting.ts',
        de: "politica.value === 'exigir'",
        a: "politica.value === 'siempre'",
        porque: 'el lector deja de comparar contra el literal del panel: la política existiría sin morder',
      },
    ],
    evaluar: () => {
      // F01: la decisión §5 no se difirió tácitamente ni se decidió en
      // código — es política del panel (segregacion_de_funciones) con
      // default off, y su lector está DENTRO del motor de posteo: con
      // 'exigir', quien creó el borrador MANUAL no lo postea. Las pólizas
      // del sistema (source_type no nulo: nómina, ai_draft, reversas)
      // quedan exentas por construcción — ahí creador=posteador es
      // intencional y exigir separación produciría falsos positivos.
      const panel = codigoDe('src/services/policy/pending-catalog.ts');
      if (!/key: 'segregacion_de_funciones'/.test(panel) || !/'exigir'/.test(panel)) {
        return falla('la clave segregacion_de_funciones salió del panel: la decisión §5 vuelve a estar diferida tácitamente');
      }
      // G3 REESCRIBIÓ ESTE CRITERIO, y el porqué importa. Antes anclaba la
      // forma `!entry.source_type && entry.created_by === userId` DENTRO de
      // postJournalEntry, o sea el candado escrito inline en una puerta. Con
      // eso en verde, `POST /v1/journal-entries {"auto_post":true}` y su
      // gemelo de GraphQL posteaban SIN consultar la política: el criterio
      // vigilaba una puerta mientras otras dos quedaban abiertas. Ahora el
      // candado es UNO —`autorizarPosteo`— y lo atraviesan todas; anclarlo
      // aquí es lo que impide volver a copiarlo, que es como se abrieron.
      const p = codigoDe('src/services/accounting/posting.ts');
      if (!/async function autorizarPosteo/.test(p)) {
        return falla('el candado de segregación dejó de estar extraído: copiado en cada puerta, en seis meses dirán cosas distintas y alguna no dirá nada');
      }
      // Y EL LOTE TIENE SU PROPIA PUERTA, con el mismo candado. Era la
      // CUARTA: la misma persona hacía `entry import` + `batch post` sin
      // segundo par de ojos mientras `entry create` + `entry post` sí se lo
      // pedía. No se arregló eximiendo menos en el motor —ahí created_by y
      // posted_by son la misma persona POR CONSTRUCCIÓN, los escribe el mismo
      // acto, así que la comparación sale trivialmente falsa— sino pasándole
      // al candado el creador que a esa puerta le consta: quien IMPORTÓ.
      if (!/export async function exigirSegregacion/.test(p)) {
        return falla('el núcleo del candado dejó de compartirse: la puerta del lote tendría que copiarlo, y una copia dice lo mismo hoy y otra cosa en seis meses');
      }
      if (!/exigirSegregacion\(\{/.test(codigoDe('src/services/accounting/batch-service.ts'))) {
        return falla('el lote importado volvió a aplicarse sin segundo par de ojos: quien importa puede aplicar, y es el camino que más asientos mueve de una vez');
      }
      // Se CUENTAN las dos lecturas del literal —la del núcleo compartido y
      // la del candado del asiento—: son gemelas textuales, y un mutante que
      // cambie una deja la otra en pie, así que la presencia seguiría siendo
      // cierta con media compuerta muerta.
      const lecturasDelLiteral = (p.match(/politica\.value === 'exigir'/g) ?? []).length;
      if (lecturasDelLiteral !== 2 || !/SOD_QUIEN_CREA_NO_POSTEA/.test(p)) {
        return falla(
          `el lector dejó de comparar contra el literal exigir en ${2 - lecturasDelLiteral} de sus dos sitios, ` +
            'o perdió su código de dominio: la política existiría sin morder'
        );
      }
      if (!/'SOD_QUIEN_CREA_NO_POSTEA'/.test(codigoDe('src/cli/entry-command.ts'))) {
        return falla('el rechazo SoD dejó de salir como BLOQUEADO (5): se leería como entrada inválida');
      }
      // El huérfano pagado: checkSoDViolations con LLAMADA real en doctor
      // (composición de permisos), y el check enchufado a runDoctor.
      // El push, no el nombre: la FIRMA de checkPermisosEnConflicto() también
      // casa `nombre()` — cuarta aparición del regex que muerde el símbolo
      // equivocado en esta serie de sprints.
      const doctor = codigoDe('src/ai/doctor-service.ts');
      return /checkSoDViolations\(permisos\)/.test(doctor) &&
        /checks\.push\(await checkPermisosEnConflicto\(\)\)/.test(doctor)
        ? ok('panel + UN candado que todas las puertas atraviesan (incluido el lote), salida bloqueada, y la composición de permisos vigilada en doctor')
        : falla('checkSoDViolations volvió a quedarse sin consumidor o el check salió de runDoctor');
    },
  },

  {
    paquete: 'E0.1',
    id: 'entity-scoped-cfdi-sat-status',
    enunciado: 'El espejo del CFDI es por entidad y el estatus SAT dice la verdad',
    evaluar: () => {
      // F02: la unicidad fiscal era GLOBAL (005) y mataba el caso normal de
      // un despacho — las dos partes de la operación como clientes, el mismo
      // XML entrando como 'emitido' y como 'recibido'. Y el estatus SAT era
      // un «Vigente» simulado: un CFDI cancelado se clasificaba vigente. La
      // 046 vuelve la unicidad (entity_id, cfdi_uuid) — y respalda xml_hash
      // en esquema —, el dedupe filtra por entidad en sus DOS sitios, y el
      // estatus sale del ConsultaCFDIService real (público y anónimo:
      // ningún bloqueo de E3.x le aplicó jamás), con apagado que LO DICE.
      const m = 'src/database/migrations/046_el_espejo_del_cfdi.sql';
      if (!existe(m)) return falla('la 046 desapareció: la unicidad fiscal vuelve a ser global');
      const sql = crudoDe(m);
      if (!/DROP CONSTRAINT xml_documents_cfdi_uuid_key/.test(sql) ||
          // \b tras el nombre: un sufijo _x seguiría casando el regex desnudo
          // — quinta variante de la familia del ancla en estos sprints.
          !/uq_xml_documents_entity_cfdi\b[\s\S]{0,80}\(entity_id, cfdi_uuid\)/.test(sql) ||
          !/uq_xml_documents_entity_hash\b[\s\S]{0,80}\(entity_id, xml_hash\)/.test(sql)) {
        return falla('la 046 perdió una de sus tres piezas (drop global, unique uuid, unique hash)');
      }
      const dedupe = /WHERE entity_id = \$1 AND \(cfdi_uuid = \$2 OR xml_hash = \$3\)/;
      if (!dedupe.test(codigoDe('src/services/xml-ingestion/pre-registration-service.ts'))) {
        return falla('el dedupe del registro dejó de filtrar por entidad: el espejo vuelve a chocar');
      }
      const ingest = codigoDe('src/ai/ingest-service.ts');
      const iPrev = ingest.indexOf('export async function previewCfdiFiles');
      const tramoPrev = iPrev >= 0 ? ingest.slice(iPrev, iPrev + 2500) : '';
      if (!/entityId: string/.test(tramoPrev) || !dedupe.test(tramoPrev)) {
        return falla('previewCfdiFiles perdió la entidad: su veredicto de duplicado sería mentira');
      }
      const stub = codigoDe('src/services/xml-ingestion/sat-validation.ts');
      if (/'Vigente'/.test(stub)) {
        return falla('sat-validation volvió a fabricar un Vigente: un cancelado se clasificaría vigente');
      }
      if (!/consultaCfdi\(/.test(stub)) {
        return falla('sat-validation dejó de delegar en el cliente real');
      }
      const cliente = codigoDe('src/services/sat/cfdi-status.ts');
      return /IConsultaCFDIService\/Consulta/.test(cliente) &&
        /toFixed\(6\)/.test(cliente) && /'DISABLED'/.test(cliente)
        ? ok('unicidad (entidad, uuid) con hash respaldado, dedupe escopado en los dos sitios, y el SOAP real con apagado honesto')
        : falla('el cliente SAT perdió el sobre, el relleno del total o el apagado que lo dice');
    },
  },

  // ---- F03 · Cobrar ----

  {
    paquete: 'E0.1',
    id: 'credit-note-posts-at-issue',
    enunciado: 'La nota de crédito postea al emitir por la vía única, y su aplicación no toca efectivo',
    mutantes: [
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "sourceType: 'credit_note'",
        a: "sourceType: 'nota'",
        porque: 'la nota pierde su source_type: el asiento quedaría sin documento',
      },
    ],
    evaluar: () => {
      // F03: la nota es documento con folio (CN), posteada por el MISMO
      // motor AR→GL que la factura (ar-ap-posting), idempotente tras su
      // journal_entry_id. La aplicación reparte en el auxiliar SIN asiento
      // (el mayor se movió al emitir) y SIN tocar amount_paid — una nota no
      // es efectivo, y confundirlos infla el cobrado que el REP reporta.
      const posting = codigoDe('src/services/accounting/ar-ap-posting.ts');
      if (!/sourceType: 'credit_note'/.test(posting)) {
        return falla('la nota dejó de postear por la vía única con su source_type: el asiento perdería su documento');
      }
      if (!/if \(note\.journal_entry_id\) return null/.test(posting)) {
        return falla('postCreditNoteEntry perdió la idempotencia: reemitir duplicaría el crédito contra CxC');
      }
      if (!/requireRole\(roles, 'devolucion_ventas'\)/.test(posting)) {
        return falla('la nota dejó de cargar al contra-ingreso por rol: caería a una cuenta adivinada');
      }
      const svc = codigoDe('src/services/ar/credit-note-service.ts');
      // La forma EXACTA del UPDATE de aplicación: baja amount_due, conserva
      // el status salvo saldado, y NO nombra amount_paid. Un mutante que
      // sume amount_paid ahí rompe este regex por construcción.
      if (!/amount_due = amount_due - \$1,\s*\n\s*status = CASE WHEN amount_due - \$1 <= 0 THEN 'paid' ELSE status END/.test(svc)) {
        return falla('la aplicación de la nota cambió su UPDATE: o toca amount_paid (una nota no es efectivo) o perdió el estado saldado');
      }
      // La liga fiscal, con sus dos guardas: ligada→sólo su factura, y
      // suelta→jamás a una PPD (el IVA quedaría varado en la 2125).
      if (!/nota\.invoice_id && nota\.invoice_id !== factura\.id/.test(svc)) {
        return falla('una nota ligada volvería a aplicarse a cualquier factura: el IVA por método de pago se descuadraría');
      }
      if (!/metodo\.metodo === 'PPD'/.test(svc)) {
        return falla('la nota suelta dejó de rechazar facturas PPD: aplicarla dejaría IVA aparcado para siempre');
      }
      return /SUM\(total_amount - amount_applied\)/.test(codigoDe('src/services/ar/ar-controls.ts'))
        ? ok('vía única con idempotencia, aplicación sin efectivo con liga fiscal, y la conciliación resta las notas por aplicar')
        : falla('ar reconcile dejó de restar las notas emitidas por aplicar: el descuadre legítimo se volvería hallazgo falso');
    },
  },
  {
    paquete: 'E0.1',
    id: 'invoice-gap-and-tax-profile',
    enunciado: 'El folio eliminado deja hueco explicado, y el perfil fiscal se valida contra catálogo antes de escribir',
    mutantes: [
      {
        archivo: 'src/database/migrations/049_cobrar.sql',
        de: 'ADD COLUMN tax_regime VARCHAR(3),',
        a: 'ADD COLUMN tax_regimen VARCHAR(3),',
        porque: 'el mutante-sufijo: «tax_regimen» CONTIENE «tax_regime» y solo \\b lo mata',
      },
    ],
    evaluar: () => {
      // F03: borrar un borrador es legal; borrar su rastro no. El DELETE
      // guarda el documento completo en audit_log y la serie cruza sus
      // huecos contra ese rastro: hueco con motivo = explicado; sin motivo
      // = hallazgo. Y el perfil fiscal (régimen/CP/UsoCFDI, 049) valida
      // contra los catálogos del SAT ANTES del UPDATE: un código inventado
      // fallaría el timbrado semanas después, donde ya nadie recuerda.
      const inv = codigoDe('src/services/ar/invoice-service.ts');
      // Conteo ×2: el folio del muerto se escribe en el audit (delete) Y se
      // busca desde la serie — mutar uno deja al otro y un chequeo de
      // presencia lo bendice.
      const rastroFolio = (inv.match(/invoice_number/g) ?? []).length;
      if (!/action: 'delete',\s*\n\s*entityType: 'invoices'/.test(inv)) {
        return falla('deleteDraftInvoice dejó de auditar el DELETE: el hueco de la serie quedaría sin explicación posible');
      }
      // Conteo ×2: el folio del audit se LEE (SELECT) y se CRUZA (WHERE);
      // mutar uno deja al otro y la presencia lo bendice.
      if ((inv.match(/old_values->>'invoice_number'/g) ?? []).length < 2) {
        return falla('checkInvoiceSeries dejó de cruzar los huecos contra el audit_log: todo hueco sería hallazgo, o peor, ninguno');
      }
      if (rastroFolio < 10) {
        return falla(`invoice_number aparece ×${rastroFolio} en invoice-service: la serie o el rastro perdieron piezas`);
      }
      // Las TRES guardas del DELETE, cada una con su ancla propia (una
      // alternativa compartida bendeciría al mutante que borre una sola).
      if (!/if \(factura\.journal_entry_id\)/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda del asiento: se podría borrar un documento que tocó el mayor');
      }
      if (!/if \(factura\.cfdi_uuid\)/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda del CFDI: un timbrado se cancela ante el SAT, no se borra');
      }
      if (!/FROM payment_allocations WHERE invoice_id = \$1/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda de cobros: se borraría una factura con dinero aplicado');
      }
      const cust = codigoDe('src/services/ar/customer-service.ts');
      // Conteo ×2 por catálogo: se usa al MOSTRAR (nombre legible) y al
      // ESCRIBIR (validación) — la validación es la que salva el timbrado.
      if (
        (cust.match(/SAT_CATALOGS\.REGIMEN_FISCAL/g) ?? []).length < 2 ||
        (cust.match(/SAT_CATALOGS\.USO_CFDI/g) ?? []).length < 2
      ) {
        return falla('el perfil fiscal dejó de validar contra los catálogos del SAT: un código inventado se guardaría y fallaría al timbrar');
      }
      if (!/RFC_CLIENTE_RE\.test\(rfc\)/.test(cust)) {
        return falla('el RFC del cliente dejó de validarse en forma antes de escribirse');
      }
      // \b: la lección del mutante-sufijo — «tax_regimen» CONTIENE
      // «tax_regime» y un regex sin frontera lo bendice.
      return /ADD COLUMN tax_regime\b/.test(
        crudoDe('src/database/migrations/049_cobrar.sql')
      )
        ? ok('DELETE con rastro completo y serie que lo lee; perfil fiscal validado contra catálogo antes del UPDATE')
        : falla('la 049 perdió las columnas del perfil fiscal: el control previo a facturar no tendría dónde vivir');
    },
  },
];
