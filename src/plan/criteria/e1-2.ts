import * as path from 'node:path';
import {
  codigoDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  fuentes,
  leer,
  ok,
  rutaDe,
  scanLedgerDateArguments,
  sinComentarios,
} from './shared.js';

// ============================================================
// THE E1.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E1_2: Criterio[] = [

  // ---- E1.2 · Cerebro fiscal del CFDI ----
  {
    paquete: 'E1.2',
    id: 'ppd-iva-parked-until-payment',
    enunciado: 'El IVA de un documento PPD se aparca y sólo el pago lo acredita',
    evaluar: () => {
      if (!existe('src/services/accounting/iva-cash-basis.ts')) {
        return falla('no existe el módulo de IVA sobre flujo');
      }
      const arap = codigoDe('src/services/accounting/ar-ap-posting.ts');
      return /iva-cash-basis/.test(arap)
        ? ok('el posteo de AR/AP consulta el método de pago')
        : falla('ar-ap-posting acredita el IVA al facturar: la declaración mensual no va a cuadrar');
    },
  },
  {
    paquete: 'E1.2',
    id: 'iva-release-capped-at-parked',
    enunciado: 'No se libera IVA que el documento nunca aparcó',
    evaluar: () => {
      const p = 'src/services/accounting/iva-cash-basis.ts';
      if (!existe(p)) return falla('no existe el módulo');
      return /ivaStillParked/.test(codigoDe(p))
        ? ok('la liberación se topa contra lo realmente aparcado')
        : falla('una factura anterior al corte abonaría por segunda vez y dejaría la cuenta pendiente en negativo');
    },
  },

  {
    paquete: 'E1.2',
    id: 'cfdi-classification-persisted',
    enunciado: 'El cerebro fiscal deja el rastro que prometió',
    evaluar: () => {
      // ROJO HONESTO NUEVO. E1.2 figura cerrado porque sus criterios miden la
      // decisión (PUE/PPD, las cuentas puente) — y esa parte es real. Pero la
      // salida prometida «queda rastro en cfdi_classifications» no ocurrió
      // jamás: la tabla existe desde la migración 015 y tiene CERO menciones
      // en src. Una clasificación que no se persiste no se puede auditar ni
      // reprocesar, y la fila del catálogo que la exige no se puede construir
      // encima de nada. F02 decide: escribirla o retirar la tabla — y este
      // criterio cambia con esa decisión, no antes.
      const escritor = dondeAparece(/INSERT\s+INTO\s+cfdi_classifications\b/i, ['src'], true);
      return escritor.length > 0
        ? ok(`el rastro se escribe desde ${escritor.join(', ')}`)
        : falla(
            'cfdi_classifications: creada en la migración 015, prometida como rastro del ' +
              'clasificador, y con cero menciones en src — la clasificación no se persiste'
          );
    },
  },
  {
    paquete: 'E1.2',
    id: 'payment-application-immutable-history',
    enunciado: 'El cobro es historia: la aplicación se clausura, su IVA viaja en la fila y la reversa es por espejos',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "SET status = 'reversed', reversed_at = NOW()",
        a: "SET status = 'void', reversed_at = NOW()",
        porque: "«reversed» degradado a «void»: ocurrió-y-rebotó es otra afirmación ante un auditor",
      },
    ],
    evaluar: () => {
      // F03: tres propiedades que mantienen el IVA de flujo de efectivo
      // verdadero cuando el cobro deja de ser una instantánea:
      // 1. SÓLO las aplicaciones VIVAS cuentan — una clausurada que siguiera
      //    contando re-liberaría el IVA que su desaplicación ya re-aparcó;
      // 2. el IVA liberado se guarda POR APLICACIÓN, para desaplicar el
      //    importe EXACTO y no re-derivarlo bajo otro contexto;
      // 3. la reversa NSF refleja CADA asiento del cobro (espejo NIF B-1) y
      //    el estado queda 'reversed' — ocurrió y rebotó, no 'void'.
      const iva = codigoDe('src/services/accounting/iva-cash-basis.ts');
      // Los DOS filtros de vida (pa y pa2): mutar uno deja al otro.
      if (!/pa\.unapplied_at IS NULL/.test(iva) || !/pa2\.unapplied_at IS NULL/.test(iva)) {
        return falla('invoicesAppliedBy volvió a contar aplicaciones clausuradas: el IVA se liberaría dos veces');
      }
      // Las DOS vías persisten el IVA de la fila, cada una donde vive: el
      // registro (posting escribe tras armar sus líneas) y la aplicación
      // posterior (el servicio, sobre las filas recién insertadas).
      const posting = codigoDe('src/services/accounting/ar-ap-posting.ts');
      const pagosSvc = codigoDe('src/services/payments/payment-service.ts');
      if (
        !/SET iva_reclass_amount = \$1/.test(posting) ||
        !/SET iva_reclass_amount = \$1 WHERE id = \$2/.test(pagosSvc)
      ) {
        return falla('el IVA por aplicación dejó de persistirse en las DOS vías (registro y aplicación posterior): desaplicar volvería a adivinar');
      }
      // El rol de anticipos se EXIGE en las tres vías (registro con
      // remanente, aplicación posterior, desaplicación): conteo de la forma
      // de llamada, no presencia — quitar una vía deja las otras dos y un
      // chequeo laxo lo bendice.
      if ((posting.match(/requireRole\(roles, 'anticipo_clientes'\)/g) ?? []).length < 3) {
        return falla('el remanente a cuenta perdió una de sus tres vías: lo no aplicado volvería a colgar de la cuenta de control');
      }
      const pagos = pagosSvc;
      if (!/voidJournalEntryInTx\(client, je\.id, userId, `NSF: /.test(pagos)) {
        return falla('la reversa NSF dejó de reflejar los asientos por la vía NIF B-1: quedaría dinero contado sin espejo');
      }
      if (!/SET status = 'reversed', reversed_at = NOW\(\)/.test(pagos)) {
        return falla("el cobro devuelto dejó de quedar 'reversed': se confundiría con 'void', que es otra afirmación ante un auditor");
      }
      // Conteo ×2: la clausura con motivo vive en DOS vías (desaplicar y
      // reversa NSF); mutar una deja la otra y la presencia lo bendice.
      return (pagos.match(/SET unapplied_at = NOW\(\), unapplied_by = \$1, unapply_reason = \$2/g) ?? []).length >= 2
        ? ok('aplicaciones con clausura (nunca DELETE), IVA exacto por fila, remanente en anticipos y reversa por espejos')
        : falla('la desaplicación dejó de clausurar con rastro: borraría historia en lugar de cerrarla');
    },
  },





  {
    paquete: 'E1.2',
    id: 'every-ledger-line-writer-carries-its-dimensions',
    // X1a (#256). `journal_entry_lines` lleva `cost_center_id` y `project_id`;
    // tres caminos las escriben —REST, el posteo AP/AR y el plan del CFDI— y
    // el mayor general las devuelve al cliente. No son decoración: alguien las
    // teclea y alguien las lee.
    //
    // Editar un borrador REEMPLAZA sus líneas: DELETE y luego INSERT. Ese
    // segundo INSERT nombraba siete columns y ninguna de dimensión, así que
    // corregir el texto de UNA línea borraba el centro de costo de TODAS, sin
    // error y sin aviso. Medido contra Postgres: el borrador nacía con su
    // centro de costo y volvía con `null`.
    //
    // El defecto vivía en la grieta entre dos mitades del mismo contrato —el
    // alta sabía escribirlas y el parche sólo sabía quitarlas—, y la forma del
    // parche se documentaba a sí misma como «la misma forma que el alta», que
    // era justo lo que no era. Por eso el criterio no comprueba el arreglo:
    // CENSA los writers de la tabla y exige que TODOS nombren las dos
    // columns. Un tercero que nazca corto sale rojo el día que nace, que es
    // lo que no pasó con éste.
    enunciado:
      'Ningún camino que escriba el mayor se lleva por delante el centro de costo de una línea',
    mutantes: [
      {
        archivo: 'src/services/accounting/journal-entry-service.ts',
        de: '            cost_center_id, project_id\n          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        a: '            project_id\n          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        porque: 'el INSERT de la edición vuelve a dejarse el centro de costo fuera: corregir el texto de una línea borra la dimensión de todas',
      },
      {
        archivo: 'src/services/accounting/journal-entry-service.ts',
        de: '      cost_center_id: line.cost_center_id ?? null,',
        a: '      cost_center_id: null,',
        porque: 'la capa que resuelve las líneas tira el centro de costo que el llamador mandó: las cuatro superficies que la usan lo pierden a la vez',
      },
      {
        archivo: 'src/services/accounting/journal-entry-service.ts',
        de: '      project_id: line.project_id ?? null,',
        a: '      project_id: null,',
        porque: 'lo mismo con el proyecto, que es la otra dimensión que el mayor general devuelve al cliente',
      },
      {
        archivo: 'tests/integration/x1a-editing-a-draft-keeps-its-dimensions.int.spec.ts',
        de: 'const COST_CENTRE = randomUUID();',
        a: 'const CENTRO = null as unknown as string;',
        porque: 'la reproducción deja de sembrar un centro de costo: comprueba que un nulo sigue siendo nulo, que es verde con el defecto puesto',
      },
    ],
    evaluar: () => {
      const spec = 'tests/integration/x1a-editing-a-draft-keeps-its-dimensions.int.spec.ts';
      const DIMENSIONS = ['cost_center_id', 'project_id'];

      // 1. EL CENSO. Todo INSERT a journal_entry_lines nombra las dos columns.
      //    Se cuenta antes de absolver: un censo vacío no es un censo limpio.
      const writers: Array<{ file: string; missing: string[] }> = [];
      for (const f of fuentes('src')) {
        const code = sinComentarios(leer(f));
        for (const m of code.matchAll(/INSERT\s+INTO\s+journal_entry_lines\s*\(([^)]*)\)/gi)) {
          const columns = m[1];
          const missing = DIMENSIONS.filter((d) => !new RegExp(`\\b${d}\\b`).test(columns));
          writers.push({ file: path.relative(rutaDe(), f), missing });
        }
      }
      if (writers.length < 2) {
        return falla(
          `sólo ${writers.length} INSERT a journal_entry_lines encontrado(s): el escáner no está viendo el árbol, y un censo que no encuentra a los writers conocidos no absuelve a nadie`
        );
      }
      const short = writers.filter((e) => e.missing.length > 0);
      if (short.length > 0) {
        return falla(
          `${short.length} de ${writers.length} escritor(es) del mayor no nombran su dimensión: ` +
            short.map((e) => `${e.file} → sin ${e.missing.join(' ni ')}`).join(' · ') +
            '. Un INSERT corto no falla: escribe NULL, y la dimensión que alguien tecleó desaparece sin aviso'
        );
      }

      // 2. LA CAPA COMPARTIDA LAS CONSERVA. Los cuatro llamadores de
      //    resolveDraftLines entregan su salida a un INSERT; si ella las tira,
      //    los cuatro las pierden a la vez y ningún INSERT parece culpable.
      const shared = codigoDe('src/services/accounting/journal-entry-service.ts');
      for (const d of DIMENSIONS) {
        if (!shared.includes(`${d}: line.${d} ?? null,`)) {
          return falla(
            `resolveDraftLines dejó de pasar ${d} desde la línea que recibe: la pierden a la vez todos sus llamadores, y el INSERT que la escribe parece correcto`
          );
        }
      }

      // 3. LA FORMA DE ENTRADA PUEDE EXPRESARLAS. El defecto nació aquí: el
      //    parche se documentaba como «la misma forma que el alta» y no podía
      //    ni nombrar lo que el alta escribía.
      const inputShape = shared.slice(shared.indexOf('interface DraftLineInput'), shared.indexOf('interface DraftEntryInput'));
      for (const d of DIMENSIONS) {
        if (!new RegExp(`${d}\\?:`).test(inputShape)) {
          return falla(
            `DraftLineInput volvió a no poder expresar ${d}: quien reemplaza las líneas no tiene cómo conservarlo, y omitirlo deja de ser una elección`
          );
        }
      }

      // 4. Y CONDUCTA contra Postgres, que es lo único que distingue «lo
      //    escribe» de «lo escribe y sobrevive a una edición».
      if (!existe(spec)) return falla('no hay reproducción contra Postgres de la edición que conserva la dimensión');
      const t = crudoDe(spec);
      const needed: Array<[RegExp, string]> = [
        [/updateDraftEntry/, 'editar de verdad el borrador, no sólo insertarlo'],
        [/autoPost: false/, 'sembrar un BORRADOR, que es lo único que se puede editar'],
        [/toBeNull\(\)/, 'medir también que omitir la dimensión la deja en nulo, que es la mitad querida del contrato'],
        [/const COST_CENTRE = randomUUID\(\);/, 'sembrar un centro de costo real: comprobar que un nulo sigue nulo es verde con el defecto puesto'],
        [/const PROJECT = randomUUID\(\);/, 'sembrar un proyecto real, por la misma razón'],
      ];
      for (const [pattern, what] of needed) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        `${writers.length} writers del mayor revisados y los dos nombran su dimensión; la capa compartida la conserva, la forma de inputShape puede expresarla, y la reproducción mide que una edición que no la toca no se la lleva`
      );
    },
  },

  {
    paquete: 'E1.2',
    id: 'subaccount-section-agrees-with-its-parent',
    // X1c (#258). Nada ataba la `fs_category` de una cuenta a la de su padre:
    // ni disparador, ni restricción, ni validación. Una cuenta de gasto podía
    // colgar de un activo y el estado seguía cuadrando — el importe sólo salía
    // en la sección equivocada de un documento que alguien firma.
    //
    // LA REGLA ES «MISMA SECCIÓN» Y ESTÁ MEDIDA, NO ARGUMENTADA. Sobre los 80
    // pares padre-hijo que la propia casa siembra, la IGUALDAD de categoría es
    // falsa once veces —1200 «Activo Fijo» es `non_current_assets` bajo 1000
    // «Activo», que es `current_assets`, y eso es contabilidad correcta— y la
    // misma sección es cierta 80 de 80. Una clave de igualdad nacería roja
    // contra el catálogo que el producto envía.
    //
    // Y EL MAPA DE SECCIONES NO SE AJUSTÓ A ESAS ONCE FILAS, que era la trampa:
    // elegir las fusiones después de ver las divergencias que tienen que
    // absolver no prueba nada. La partición es la que `account_type` YA dibuja,
    // y su apoyo independiente es que las dos coinciden en las 54 cuentas
    // sembradas — un hecho sobre TODAS las filas, no sólo sobre las que
    // divergen. Por eso este criterio exige que ese cotejo siga en la
    // reproducción: es lo único que distingue una regla medida de una ajustada.
    enunciado:
      'Una subcuenta no cae en una sección distinta de la de su padre sin que alguien lo haya elegido',
    mutantes: [
      {
        archivo: 'src/services/accounting/parent-child-coherence.ts',
        de: 'if (childSection === parentSection) return null;',
        a: 'if (childSection !== parentSection) return null;',
        porque: 'la comprobación de la arista absuelve siempre: una cuenta de gasto vuelve a poder colgar de un activo y el estado sigue cuadrando',
      },
      {
        archivo: 'src/services/accounting/parent-child-coherence.ts',
        de: "  ori: 'equity',",
        a: "  ori: 'income',",
        porque: 'el ORI sale del capital: la 3600 que el propio catálogo siembra bajo 3000 pasa a ser una infracción, y la regla acusa al producto',
      },
      {
        archivo: 'src/services/accounting/parent-child-coherence.ts',
        de: 'return byType === byCategory;',
        a: 'return true;',
        porque: 'el apoyo independiente del mapa deja de comprobarse: las secciones podrían ajustarse a las filas que tienen que absolver y nadie lo notaría',
      },
      {
        archivo: 'src/services/accounting/account-service.ts',
        de: "'child' AS side FROM accounts WHERE parent_id = $2",
        a: "'child' AS side FROM accounts WHERE id = $2",
        porque: 'editar el PADRE deja de mirar a sus hijas: el lado que nadie miraba vuelve a quedar sin vigilar, y una edición las deja huérfanas de sección',
      },
      {
        archivo: 'tests/integration/x1c-a-subaccount-stays-in-its-parent-section.int.spec.ts',
        de: '    expect(sameCategory.length).toBeLessThan(edges.length);',
        a: '    expect(sameCategory.length).toBeLessThanOrEqual(edges.length);',
        porque: 'la reproducción deja de medir que la IGUALDAD es falsa en el catálogo de la casa, que es la razón entera de que la regla sea por sección',
      },
    ],
    evaluar: () => {
      const module = 'src/services/accounting/parent-child-coherence.ts';
      const svc = 'src/services/accounting/account-service.ts';
      const spec = 'tests/integration/x1c-a-subaccount-stays-in-its-parent-section.int.spec.ts';
      for (const f of [module, svc]) if (!existe(f)) return falla(`desapareció ${f}`);

      // 1. LA DECISIÓN ESTÁ EN EL PANEL, Y TIENE LECTOR. Una política sin
      //    lector es una pregunta que no cambia nada.
      const panel = codigoDe('src/services/policy/pending-catalog.ts');
      if (!panel.includes("key: 'catalogo_coherencia_padre_hijo'")) {
        return falla('la coherencia padre-hijo dejó de ser una pregunta del panel: volvió a elegirse en el código');
      }
      const coherence = codigoDe(module);
      if (!coherence.includes("getPolicy({ tenantId, entityId }, COHERENCE_POLICY_KEY)")) {
        return falla('la clave del panel se quedó sin lector: el despacho contesta y nada cambia');
      }
      // La IGUALDAD no se ofrece, y no es capricho: haría ilegal el catálogo
      // que el propio producto siembra.
      if (/'igualdad|misma_categoria|igual_al_padre/.test(panel)) {
        return falla(
          'el panel volvió a ofrecer la igualdad de categoría: es falsa once veces en el catálogo que la casa siembra, así que sería una opción que rompe el producto'
        );
      }

      // 2. EL MAPA ES TOTAL Y TIENE APOYO INDEPENDIENTE.
      if (!coherence.includes('Record<FsCategory, StatementSection>')) {
        return falla(
          'el mapa de secciones dejó de ser un registro total: un valor nuevo del CHECK entraría sin que nadie diga a qué sección pertenece'
        );
      }
      // El mapa se ancla donde lleva contabilidad dentro, no entero: el ORI es
      // capital por la NIF B-3, y moverlo de sección acusaría a la 3600 que el
      // propio catálogo siembra.
      if (!coherence.includes("ori: 'equity',")) {
        return falla('el ORI dejó de ser capital en el mapa de secciones: la 3600 que la casa siembra bajo 3000 pasaría a ser una infracción');
      }
      if (!coherence.includes('if (childSection === parentSection) return null;')) {
        return falla('la comparación que absuelve una arista cambió: o absuelve lo que debía acusar, o acusa lo que debía absolver');
      }
      if (!coherence.includes('return byType === byCategory;')) {
        return falla('el cotejo del mapa contra account_type dejó de comparar: absuelve siempre, y el mapa puede ajustarse a las filas que tiene que absolver');
      }
      if (!coherence.includes('export function coherenceOfOwnRow')) {
        return falla(
          'desapareció el cotejo del mapa contra la partición de account_type: sin él, las secciones pueden ajustarse a las filas que tienen que absolver'
        );
      }

      // 3. LOS DOS LADOS DE LA ESCRITURA. El alta mira hacia arriba; la edición
      //    mira hacia arriba Y hacia abajo, que es la mitad que faltaba.
      const code = codigoDe(svc);
      const createAt = code.indexOf('breachOfEdge({ code: input.code, fs_category: input.fs_category }, parent)');
      const childrenAt = code.indexOf("'child' AS side FROM accounts WHERE parent_id =");
      if (createAt < 0) {
        return falla('createAccount dejó de comprobar la arista con su padre: la cuenta nace ya en la sección equivocada');
      }
      if (childrenAt < 0) {
        return falla(
          'updateAccount dejó de mirar a las HIJAS: editar el padre las deja en otra sección y ninguna consulta del árbol pregunta por ellas'
        );
      }

      // 4. Y CONDUCTA: la reproducción mide la regla en vez de citarla, y
      //    prueba los tres estados —rehúsa, admite, y no juzga.
      if (!existe(spec)) return falla('no hay reproducción contra Postgres de la coherencia padre-hijo');
      const t = crudoDe(spec);
      const needed: Array<[RegExp, string]> = [
        [/expect\(sameCategory\.length\)\.toBeLessThan\(edges\.length\)/, 'medir que la IGUALDAD es falsa en el catálogo sembrado, que es la razón entera de la regla'],
        [/expect\(sameSection\.length\)\.toBe\(edges\.length\)/, 'medir que la misma sección sí se cumple en todas'],
        [/coherenceOfOwnRow/, 'comprobar el mapa contra la partición de account_type, que es su apoyo independiente'],
        [/with its CHILDREN/, 'probar el lado de las hijas, que es el que nadie miraba'],
        [/no category/, 'probar que una arista sin categoría NO se juzga: si no, un despacho no puede migrar su catálogo del SAT'],
      ];
      for (const [pattern, what] of needed) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        'la coherencia padre-hijo la decide el panel y tiene lector; el mapa de secciones es total y se coteja contra la partición de account_type; el alta mira al padre y la edición mira también a las hijas; y la reproducción mide la regla en vez de citarla'
      );
    },
  },

  {
    paquete: 'E1.2',
    id: 'a-stored-date-is-read-back-whole',
    // #241. La otra mitad de #211. Aquélla arregló la ESCRITURA: el día que el
    // usuario teclea es el que la columna guarda. Ésta es la LECTURA: pg
    // construye el Date de una columna DATE a medianoche LOCAL, y
    // `.toISOString()` relee ese instante en UTC — así que al ESTE de Greenwich
    // devuelve el día anterior al guardado.
    //
    // Siete sitios, y no eran display: la puerta del periodo de conciliación
    // (decide en qué mes cae un movimiento, o lo rechaza por periodo cerrado),
    // el día que juzga si un descuento por pronto pago sigue vigente, el
    // fichero ACH que se le entrega al banco —un pay_date de 2026-01-01 salía
    // como `251231`, el día Y el año, mientras la fila que lo registra guardaba
    // el correcto—, y lo que el agente le cuenta al usuario como un hecho.
    //
    // El criterio CENSA la forma, no los siete sitios: `toISOString` sobre algo
    // que vino de una columna DATE. Un octavo nace igual de mal el día que
    // alguien lo escriba.
    enunciado: 'La fecha que el mayor guardó es la que se lee de vuelta, en cualquier huso',
    mutantes: [
      {
        archivo: 'src/services/payroll/usa/nacha-generator.ts',
        de: "const [yyyy, mm, dd] = toCalendarDate(date).split('-');",
        a: "const [yyyy, mm, dd] = new Date(date).toISOString().slice(0, 10).split('-');",
        porque: 'el fichero ACH vuelve a leer la fecha efectiva en UTC: un pago del 1 de enero sale fechado el 31 de diciembre del año anterior',
      },
      {
        archivo: 'src/services/banking/match-service.ts',
        de: 'const params = [entityId, toCalendarDate(fecha)];',
        a: "const params = [entityId, fecha.toISOString().split('T')[0]];",
        porque: 'la puerta del periodo vuelve a preguntar por el día anterior: el movimiento cae en el mes equivocado o se rechaza por periodo cerrado',
      },
      {
        archivo: 'src/ai/tools/ledger-tools.ts',
        de: 'je.entry_date::text AS entry_date',
        a: 'je.entry_date',
        porque: 'el agente vuelve a serializar un DATE con JSON.stringify, que lo pinta en UTC: le cuenta al usuario un día que no es el guardado',
      },
      {
        archivo: 'tests/utils/stored-dates-are-read-back-whole.spec.ts',
        de: "const [y, m, d] = iso.split('-').map(Number);\n  return new Date(y, m - 1, d);",
        a: "return new Date(iso);",
        porque: 'la fixture deja de imitar a pg —medianoche LOCAL— y pasa a construir medianoche UTC, que es la única forma en que el defecto no se ve',
      },
    ],
    evaluar: () => {
      const spec = 'tests/utils/stored-dates-are-read-back-whole.spec.ts';

      // 1. EL CENSO. Los sitios que leen una fecha del mayor no la reinterpretan.
      const VIGILADOS = [
        'src/services/banking/match-service.ts',
        'src/services/payments/payment-service.ts',
        'src/services/payroll/usa/nacha-generator.ts',
        'src/services/accounting/journal-entry-service.ts',
        'src/ai/tools/ledger-tools.ts',
        'src/ai/ingest-service.ts',
        'src/services/xml-ingestion/cfdi-decisions.ts',
      ];
      const culpables: string[] = [];
      for (const rel of VIGILADOS) {
        if (!existe(rel)) return falla(`desapareció ${rel}`);
        const code = sinComentarios(leer(rutaDe(rel)));
        if (/\.toISOString\(\)\s*\.(?:split\('T'\)\[0\]|slice\(0,\s*10\))/.test(code)) {
          culpables.push(rel);
        }
      }
      if (culpables.length > 0) {
        return falla(
          `${culpables.length} sitio(s) vuelven a cortar un día de un toISOString (${culpables.join(', ')}): ` +
            'pg entrega un DATE a medianoche LOCAL y toISOString lo relee en UTC, así que al este de Greenwich se lee el día ANTERIOR al guardado'
        );
      }

      // 2. LAS TRES PUERTAS QUE MUEVEN ALGO, por su ancla.
      if (!codigoDe('src/services/banking/match-service.ts').includes('const params = [entityId, toCalendarDate(fecha)];')) {
        return falla('la puerta del periodo de conciliación dejó de normalizar el día: el movimiento vuelve a poder caer en el mes equivocado');
      }
      if (!codigoDe('src/services/payroll/usa/nacha-generator.ts').includes("const [yyyy, mm, dd] = toCalendarDate(date).split('-');")) {
        return falla('el fichero ACH volvió a leer su fecha efectiva por campos UTC: un pago de año nuevo retrocede el año entero');
      }
      // LAS DOS consultas, contadas: el archivo tiene dos y anclar en el texto
      // dejaba vivo al mutante que quitaba una — un ancla repetida desarma su
      // propio espejo.
      const conCast = (codigoDe('src/ai/tools/ledger-tools.ts').match(/entry_date::text AS entry_date/g) ?? []).length;
      if (conCast < 2) {
        return falla(
          `sólo ${conCast} de las 2 consultas del agente entregan el día como texto: JSON.stringify pinta un DATE en UTC y le cuenta al usuario otro día`
        );
      }

      // 3. Y CONDUCTA con el reloj movido, que es lo único que lo hace visible.
      if (!existe(spec)) return falla('no hay reproducción de la lectura con el reloj movido');
      const t = codigoDe(spec);
      for (const [pattern, what] of [
        [/Asia\/Tokyo/, 'medir al ESTE, que es donde la lectura retrocede el día'],
        [/America\/Mexico_City/, 'medir al oeste, para que el arreglo no rompa la otra mitad'],
        [/new Date\(y, m - 1, d\)/, 'imitar a pg —medianoche LOCAL—: con medianoche UTC el defecto no se ve'],
        [/yymmdd/, 'medirlo en el fichero que se le entrega al banco, y no sólo en el normalizador'],
      ] as Array<[RegExp, string]>) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        `${VIGILADOS.length} sitios que leen una fecha del mayor revisados sin reinterpretarla; la puerta del periodo, el fichero ACH y lo que ve el agente van por el normalizador; y la reproducción lo mide al este y al oeste con una fixture que imita a pg`
      );
    },
  },

  {
    paquete: 'E1.2',
    id: 'days-are-counted-on-the-calendar-not-on-a-clock',
    // #243. Tres sitios restaban milisegundos y dividían entre 86 400 000, y
    // los dos operandos nunca eran la misma cosa: un lado llegaba como cadena
    // 'YYYY-MM-DD' —que `new Date()` lee como medianoche UTC— y el otro como el
    // Date que pg construye de una columna DATE, que es medianoche LOCAL.
    // Restarlos mezcla dos orígenes separados por el desfase del huso, y el
    // cociente cae un día entero fuera en media esfera.
    //
    // Medido sobre un gasto del 1 de agosto, 2/10 Net 30, pagado el 12 —el día
    // ONCE, fuera de la ventana—: UTC contestaba 11 y no daba descuento;
    // Mexico_City, Tijuana y New_York contestaban 10 y concedían un 2 % que ya
    // había vencido. Los otros dos sitios dividen un sueldo y viajan en el XML
    // que se le timbra al SAT.
    //
    // Ni redondear ni truncar lo arregla: el error está en los operandos, no en
    // la división. Por eso el criterio CENSA que no quede ninguna resta cruda,
    // en vez de comprobar los tres sitios que hoy conocemos.
    enunciado: 'Los días entre dos fechas se cuentan igual en cualquier huso del servidor',
    mutantes: [
      {
        archivo: 'src/utils/calendar-date.ts',
        de: 'const [ty, tm, td] = toCalendarDate(to).split(\'-\').map(Number);',
        a: 'const [ty, tm, td] = String(to).split(\'-\').map(Number);',
        porque: 'un extremo deja de normalizarse: el Date que pg entrega vuelve a leerse por su texto ISO en UTC y el conteo se descuadra al oeste de Greenwich',
      },
      {
        archivo: 'src/services/ap/bill-service.ts',
        de: 'const daysUntilPayment = daysBetween(bill.bill_date, paymentDate);',
        a: 'const daysUntilPayment = Math.floor((new Date(paymentDate).getTime() - new Date(bill.bill_date).getTime()) / 86400000);',
        porque: 'vuelve la resta de milisegundos justo donde reparte dinero: el descuento del 2 % se concede un día después de vencido en media esfera',
      },
      {
        archivo: 'tests/utils/days-between.spec.ts',
        de: "process.env.TZ = tz;",
        a: "process.env.TZ = process.env.TZ;",
        porque: 'la reproducción deja de cambiar de zona: todas las aserciones corren en el huso de CI, que es UTC — la única zona donde el defecto no se ve',
      },
    ],
    evaluar: () => {
      const util = 'src/utils/calendar-date.ts';
      const spec = 'tests/utils/days-between.spec.ts';
      if (!existe(util)) return falla(`desapareció ${util}`);

      // 1. EL CENSO: ninguna resta cruda de milisegundos para contar días.
      // Se busca LA FORMA QUE FALLA, no el divisor: restar dos instantes de
      // verdad —cuánto falta para que venza una credencial— en milisegundos es
      // correcto, y `Date.UTC` sobre las partes de una fecha también. Lo que
      // no vale es restar dos `new Date(...)` construidos de orígenes
      // distintos, que es de donde salía el día suelto.
      const MEZCLA = /new Date\([^)]*\)\.getTime\(\)\s*-\s*new Date\([^)]*\)\.getTime\(\)[\s\S]{0,40}86[_ ]?400[_ ]?000/;
      const crudos: string[] = [];
      for (const f of fuentes('src')) {
        const code = sinComentarios(leer(f));
        if (MEZCLA.test(code)) crudos.push(path.relative(rutaDe(), f));
      }
      if (crudos.length > 0) {
        return falla(
          `${crudos.length} sitio(s) vuelven a contar días restando milisegundos (${crudos.join(', ')}): ` +
            'una cadena es medianoche UTC y un DATE de pg es medianoche local, así que la resta mezcla dos orígenes y el día sobra o falta según dónde esté el servidor'
        );
      }

      // 2. EL CONTADOR NORMALIZA LOS DOS EXTREMOS. Uno solo no basta: el defecto
      //    era precisamente que los operandos venían de origenes distintos.
      const code = codigoDe(util);
      if (!code.includes('export function daysBetween')) {
        return falla('desapareció daysBetween: cada sitio vuelve a contar los días a su manera');
      }
      if (!code.includes("toCalendarDate(from)") || !code.includes("toCalendarDate(to)")) {
        return falla('daysBetween dejó de normalizar los DOS extremos: basta con que uno llegue crudo para que el conteo vuelva a depender del huso');
      }

      // 3. Y CONDUCTA con el reloj movido, que es lo único que lo hace visible:
      //    CI corre en UTC, la única zona donde el defecto no aparece.
      if (!existe(spec)) return falla('no hay reproducción del conteo de días con el reloj movido');
      const t = codigoDe(spec);
      for (const [pattern, what] of [
        [/America\/Mexico_City/, 'medir al oeste de Greenwich, que es donde el descuento se concedía vencido'],
        [/Asia\/Tokyo/, 'medir al este, para que el arreglo no rompa la otra mitad'],
        [/process\.env\.TZ = tz;/, 'mover de verdad el reloj del proceso'],
        [/earlyPaymentDiscount/, 'medirlo donde reparte dinero, y no sólo en la función pura'],
      ] as Array<[RegExp, string]>) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        'ningún sitio cuenta días restando milisegundos; el contador normaliza los dos extremos; y la reproducción lo mide con el reloj movido al oeste y al este, incluido el descuento por pronto pago'
      );
    },
  },

  {
    paquete: 'E1.2',
    id: 'an-advance-cannot-be-booked-in-another-currency',
    // T23 (#130). Un anticipo puro no tiene documento que le dé la moneda: sale
    // del propio cliente —o del parámetro— y se escribía CRUDA, sin compararla
    // nunca con la funcional de la entidad. Medido contra Postgres: un anticipo
    // de 1 000 USD contra una entidad que lleva sus libros en MXN se registraba
    // sin protestar, y el asiento cuadraba porque las dos patas llevaban la
    // misma cifra equivocada.
    //
    // El lado proveedor ya cotejaba la funcional antes de postear; el de
    // cliente lo hacía sólo cuando había documentos. La rama sin documentos
    // —que es precisamente la que no tiene de dónde sacar la moneda— era el
    // hueco.
    //
    // REHUSAR ES EL ARREGLO ENTERO, y el criterio lo fija: convertir exige
    // elegir tasa y FUENTE, y eso lo decide el despacho en `fuente_tipo_cambio`.
    // Un valor por omisión aquí sería elegirle el criterio fiscal.
    enunciado: 'Un anticipo en otra moneda no se asienta como si fuera de la funcional',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'if (advanceCurrency !== functionalCurrency) {',
        a: 'if (advanceCurrency === functionalCurrency) {',
        porque: 'la comparación se invierte: pasa el anticipo en otra moneda y se rehúsa el que sí está en la funcional',
      },
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'const functionalCurrency = await functionalCurrencyOf(client, entrada.entityId);',
        a: 'const functionalCurrency = advanceCurrency;',
        porque: 'la funcional deja de leerse de la entidad y se toma del propio anticipo: la comparación se vuelve tautológica y nunca acusa',
      },
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'vendorAdvanceCurrency ?? currencyOf(documentos), entrada.paymentMethod',
        a: 'currencyOf(documentos), entrada.paymentMethod',
        porque: 'el anticipo a proveedor vuelve a caer en el respaldo literal «MXN» de currencyOf: se asienta en pesos sin preguntar al proveedor, al llamador ni a la entidad',
      },
      {
        archivo: 'tests/integration/t23-a-pure-advance-in-another-currency.int.spec.ts',
        de: "await expect(advance(customerMxn, 'EUR')).rejects.toThrow(ValidationError);",
        a: "await expect(advance(customerMxn)).rejects.toThrow(ValidationError);",
        porque: 'la reproducción deja de probar la segunda puerta —el parámetro explícito, que gana sobre la moneda del cliente— y pasa a exigir que se rehúse un anticipo correcto',
      },
    ],
    evaluar: () => {
      const svc = 'src/services/payments/payment-service.ts';
      const spec = 'tests/integration/t23-a-pure-advance-in-another-currency.int.spec.ts';
      const vendorSpec = 'tests/integration/t23b-a-vendor-advance-has-a-currency-too.int.spec.ts';
      if (!existe(svc)) return falla(`desapareció ${svc}`);
      const code = codigoDe(svc);

      // 1. LA GUARDA VIVE EN LA RAMA SIN DOCUMENTOS, que es la que no tiene de
      //    dónde sacar la moneda. Se comprueba el ORDEN: la funcional se lee
      //    después de resolver la del anticipo y antes del INSERT.
      // Cada lado se mide DENTRO de su función: `functionalCurrency` y la
      // lectura de la funcional aparecen ahora en las dos, y un `indexOf` sobre
      // el archivo entero devuelve la del proveedor al juzgar al cliente.
      const customerSide = code.slice(code.indexOf('export async function recordCustomerPayment'));
      const resuelve = customerSide.indexOf('advanceCurrency = entrada.currencyCode ?? c.rows[0].currency_code;');
      const lee = customerSide.indexOf('const functionalCurrency = await functionalCurrencyOf(client, entrada.entityId);');
      const compara = customerSide.indexOf('if (advanceCurrency !== functionalCurrency) {');
      const inserta = customerSide.indexOf('INSERT INTO customer_payments');
      if (resuelve < 0) return falla('cambió la resolución de la moneda del anticipo: la guarda puede haber quedado colgando de otra rama');
      if (lee < 0 || compara < 0) {
        return falla(
          'el anticipo sin documento dejó de cotejar su moneda contra la funcional de la entidad: mil dólares vuelven a poder asentarse como mil pesos'
        );
      }
      if (!(resuelve < lee && lee < compara && compara < inserta)) {
        return falla('la guarda del anticipo quedó fuera de orden: comprueba después de escribir, o antes de saber qué moneda es');
      }

      // 2. REHÚSA, NO CONVIERTE. Una conversión silenciosa aquí sería elegirle
      //    al despacho la fuente del tipo de cambio.
      const mensaje = customerSide.slice(compara, inserta);
      if (!/fuente_tipo_cambio/.test(mensaje)) {
        return falla('el rechazo dejó de decir que la tasa y su fuente las decide el panel: sin eso parece una limitación y no una negativa razonada');
      }

      // 3. LA MISMA PUERTA DEL LADO PROVEEDOR (T23b), que era peor: sin
      //    documentos, `currencyOf` cae a un LITERAL 'MXN', así que no preguntaba
      //    ni al proveedor ni a nadie.
      const vendorSide = code.slice(code.indexOf('export async function recordVendorPayment'));
      const resolvesVendor = vendorSide.indexOf('vendorAdvanceCurrency = entrada.currencyCode ?? v.rows[0].currency_code;');
      const checksVendor = vendorSide.indexOf('if (vendorAdvanceCurrency !== functionalCurrency) {');
      const writesVendor = vendorSide.indexOf('INSERT INTO vendor_payments');
      // Se CUENTAN las dos lecturas en vez de buscarlas por rebanada: la del
      // proveedor y la del cliente son la misma línea, y una rebanada que
      // empieza en una función y acaba en el fin del archivo encuentra la de la
      // otra — el mutante que neutralizaba la primera sobrevivía por eso.
      const functionalReads = (code.match(/const functionalCurrency = await functionalCurrencyOf\(client, entrada\.entityId\);/g) ?? []).length;
      if (functionalReads < 2) {
        return falla(
          `sólo ${functionalReads} de los 2 anticipos leen la funcional DE LA ENTIDAD: si se toma del propio anticipo, la comparación es tautológica y no acusa nunca`
        );
      }
      if (resolvesVendor < 0 || checksVendor < 0) {
        return falla(
          'el anticipo a PROVEEDOR dejó de cotejar su moneda: `currencyOf` cae a la cadena «MXN» cuando no hay documentos, así que se asienta en pesos sin preguntarle a nadie'
        );
      }
      if (!(resolvesVendor < checksVendor && checksVendor < writesVendor)) {
        return falla('la guarda del anticipo a proveedor quedó fuera de orden respecto a su INSERT');
      }
      if (!code.includes('vendorAdvanceCurrency ?? currencyOf(documentos)')) {
        return falla('el INSERT del pago a proveedor volvió a tomar la moneda del respaldo literal en vez de la resuelta');
      }

      // 4. Y CONDUCTA: las DOS puertas, la del cliente y la del parámetro.
      if (!existe(spec)) return falla('no hay reproducción contra Postgres del anticipo en otra moneda');
      const t = codigoDe(spec);
      for (const [pattern, what] of [
        [/advance\(customerUsd\)/, 'probar la puerta de la moneda del CLIENTE'],
        [/advance\(customerMxn, 'EUR'\)/, 'probar la puerta del PARÁMETRO, que gana sobre la del cliente'],
        [/advance\(customerMxn\)\s*;|const r = await advance\(customerMxn\)/, 'probar que el anticipo en la funcional SÍ entra: una guarda que rehúsa todo no es una guarda'],
      ] as Array<[RegExp, string]>) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      if (!existe(vendorSpec)) {
        return falla('no hay reproducción del anticipo a PROVEEDOR: es la otra mitad de la misma puerta y era la peor de las dos');
      }

      return ok(
        'los anticipos sin documento —cliente Y proveedor— cotejan su moneda contra la funcional antes de escribir, rehúsa en vez de convertir —y dice que la fuente la decide el panel—, y la reproducción prueba las dos puertas y el caso que sí entra'
      );
    },
  },

  // ---- F05d · La firma y el sello ----

  {
    paquete: 'E1.2',
    id: 'calendar-dates-reach-the-ledger-unparsed',
    // #211. `entry_date` is DATE, and node-postgres sends a JS Date with the
    // process's LOCAL fields. A `new Date('YYYY-MM-DD')` is UTC midnight, so
    // west of Greenwich the column got the previous day. Measured through REST
    // with the clock in America/Mexico_City: an entry dated March 1st stored on
    // February 28th in February's period; an entry and a customer receipt
    // dated January 1st refused with PERIOD_CLOSED; a reversal a day early; a
    // vendor payment stored on April 1st with ITS OWN entry on March 31st. CI
    // runs in UTC, where none of it shows.
    //
    // `treasury-entry-date-local-midnight` guards one file by counting a
    // function name; it was green on main with all of this shifting. This one
    // measures the three things that make the day survive any clock: the
    // normaliser never reparses a string and reads a Date by local fields; the
    // sink binds that one normalised day to the period, the folio and the
    // INSERT; and no caller reparses the date on its way in.
    enunciado:
      'La fecha que el usuario escribe es la que el mayor guarda, en cualquier zona horaria del servidor',
    mutantes: [
      {
        archivo: 'src/api/rest/routes/journal-entries.ts',
        de: "midnight, which west of Greenwich is the previous day in the DATE column.\n      entry_date,",
        a: "midnight, which west of Greenwich is the previous day in the DATE column.\n      new Date(entry_date),",
        porque: 'the REST entry reparses its date again: March 1st lands on February 28th west of Greenwich, and January 1st is refused',
      },
      {
        archivo: 'src/api/rest/routes/journal-entries.ts',
        de: '      reversalDate: reversal_date,',
        a: '      reversalDate: reversal_date ? new Date(reversal_date) : undefined,',
        porque: 'the reversal is posted a day early west of Greenwich — always posted, and a posted entry is only undone by another one',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: '    payment.payment_date,\n    JournalEntryType.AUTO_PAYMENT,\n    iva.documents.length',
        a: '    new Date(payment.payment_date),\n    JournalEntryType.AUTO_PAYMENT,\n    iva.documents.length',
        porque: 'the customer receipt entry lands a day before its receipt, and a receipt dated January 1st is refused',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: '      payment.payment_date,\n      JournalEntryType.AUTO_PAYMENT,',
        a: '      new Date(payment.payment_date),\n      JournalEntryType.AUTO_PAYMENT,',
        porque: 'the foreign-currency vendor payment entry lands a day before its payment: the subledger and the ledger disagree on the day',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: '    payment.payment_date,\n    JournalEntryType.AUTO_PAYMENT,\n    (iva.documents.length',
        a: '    new Date(payment.payment_date),\n    JournalEntryType.AUTO_PAYMENT,\n    (iva.documents.length',
        porque: 'the vendor payment entry lands a day before its payment — measured: payment on April 1st, its own entry on March 31st',
      },
      {
        archivo: 'src/services/payroll/common/gl-posting-service.ts',
        de: '    pr.pay_date,',
        a: '    new Date(pr.pay_date),',
        porque: 'a caller no conduct test exercises reparses its date again: the payroll entry is only as safe as whatever type that row happens to carry',
      },
      {
        archivo: 'src/utils/calendar-date.ts',
        de: 'value.getDate()',
        a: 'value.getUTCDate()',
        porque: 'a Date is read by its UTC day: a local evening becomes tomorrow west of Greenwich, and a local-midnight row becomes yesterday east of it',
      },
      {
        archivo: 'src/utils/calendar-date.ts',
        de: '.exec(String(value).trim());',
        a: '.exec(new Date(String(value)).toISOString());',
        porque: 'the string is reparsed through Date — exactly the construction that shifted the day — and an ISO string with a time is reinterpreted instead of cut',
      },
      {
        archivo: 'src/services/accounting/posting.ts',
        de: '      [entityId, entryDay]',
        a: '      [entityId, entryDate]',
        porque: 'the period is chosen from the raw argument and the INSERT from the normalised day: the two can disagree, and the entry lands in a period that is not its date',
      },
      {
        archivo: 'tests/integration/journal-entry-date-west-of-greenwich.int.spec.ts',
        de: "const offset = new Date('2026-03-01T12:00:00Z').getTimezoneOffset();",
        a: 'const offset = expectedOffsetMinutes;',
        porque: 'the reproduction stops checking that the timezone switch took effect: on a machine without timezone data every case passes for the wrong reason',
      },
    ],
    evaluar: () => {
      const normaliser = 'src/utils/calendar-date.ts';
      const sink = 'src/services/accounting/posting.ts';
      const spec = 'tests/integration/journal-entry-date-west-of-greenwich.int.spec.ts';
      for (const f of [normaliser, sink]) if (!existe(f)) return falla(`desapareció ${f}`);

      // 1. THE NORMALISER: a string is cut, never reparsed; a Date is read LOCAL.
      const norm = codigoDe(normaliser);
      const stringBranchAt = norm.indexOf('.exec(String(value).trim())');
      if (stringBranchAt < 0 || /new Date\((String\()?value/.test(norm)) {
        return falla(
          'toCalendarDate volvió a reinterpretar la cadena con new Date: un YYYY-MM-DD es medianoche UTC, y al oeste de Greenwich eso es el día anterior'
        );
      }
      if (!norm.includes('value.getFullYear(), value.getMonth() + 1, value.getDate()') || /value\.getUTC/.test(norm)) {
        return falla(
          'toCalendarDate dejó de leer un Date por sus campos LOCALES, que son el día que pg envía y el que pg devuelve para una columna DATE'
        );
      }

      // 2. THE SINK: one normalised day, bound to the period, the folio and the
      // INSERT — measured by the key each one receives, not by presence.
      const s = codigoDe(sink);
      const normalisedAt = s.indexOf('const entryDay = toCalendarDate(entryDate);');
      const periodAt = s.indexOf('[entityId, entryDay]');
      const sequenceAt = s.indexOf("nextEntityNumber(client, entityId, 'journal_entry', 'JE', entryDay)");
      const insertAt = s.indexOf('options?.reference || null, entryDay, description, createdBy,');
      if (normalisedAt < 0) {
        return falla('createJournalEntry dejó de normalizar su fecha: vuelve a depender de cómo la construyó cada llamador');
      }
      if (periodAt < 0 || sequenceAt < 0 || insertAt < 0) {
        return falla(
          'el periodo, el folio o el INSERT de createJournalEntry dejaron de recibir el día normalizado: pueden volver a discrepar entre sí y con la fecha escrita'
        );
      }
      if (!(normalisedAt < periodAt && periodAt < sequenceAt && sequenceAt < insertAt)) {
        return falla('el día normalizado se usa antes de existir: el orden normalizar → periodo → folio → INSERT se rompió');
      }

      // 3. NO CALLER REPARSES THE DATE ON ITS WAY IN.
      const { calls, findings } = scanLedgerDateArguments();
      if (calls < 20) {
        return falla(`sólo ${calls} llamadas a createJournalEntry encontradas: el escáner no está viendo el árbol, y un censo vacío no es un censo limpio`);
      }
      if (findings.length > 0) {
        return falla(
          `${findings.length} llamada(s) reinterpretan la fecha antes de entregarla al mayor: ` +
            findings.slice(0, 4).map((x) => `${x.site} — ${x.issue}`).join(' · ') +
            '. Pasa la cadena o el Date de la fila tal cual: createJournalEntry la normaliza'
        );
      }

      // 4. AND CONDUCT, meaningful in a UTC CI: the zone is switched, checked
      // and restored inside the reproduction, west AND east.
      if (!existe(spec)) return falla('no hay reproducción contra Postgres: en CI el reloj es UTC y el defecto no se ve sin ella');
      const t = crudoDe(spec);
      const needed: Array<[RegExp, string]> = [
        [/getTimezoneOffset\(\)/, 'comprobar que el cambio de zona surtió efecto'],
        [/America\/Mexico_City/, 'medir al oeste de Greenwich'],
        [/Asia\/Tokyo/, 'medir que el arreglo no rompe el este'],
        [/entry_date::text/, 'leer el día guardado como texto, no como Date'],
        [/JOIN journal_entries je ON je\.id = p\.journal_entry_id/, 'leer la póliza por la llave del propio pago'],
      ];
      for (const [pattern, what] of needed) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        `${calls} llamadas a createJournalEntry revisadas sin fecha reinterpretada; el mayor normaliza una vez y ata ese día al periodo, al folio y al INSERT; y la reproducción lo mide al oeste y al este`
      );
    },
  },
  {
    paquete: 'E1.2',
    id: 'published-figures-are-the-firms-own',
    // X0 (#118). `POST /v1/admin/blockchain/publish-aggregates` signed and
    // published figures the firm contradicts in its own report, because it
    // computed them with a SECOND query over the ledger. Measured against
    // Postgres:
    //
    //   revenue with a sales return ....  8,000 in the report, 12,000 published
    //   expenses with a purchase return   2,000 in the report,  4,000 published
    //   the month of the year-end close     500 in the report, -8,000 published
    //
    // Two causes, and neither is an arithmetic slip. First: the sign was
    // flipped per ACCOUNT, so a return — contra-natural inside its section —
    // was added instead of subtracted. Second: publication never asked about
    // CLOSING entries, and the annual sweep lands whole in the period it falls
    // in, so the month of the close published the year's result as if it were
    // that month's activity.
    //
    // That is why this criterion does not check the fix: it checks that there
    // is only ONE PLACE where it can break again. While two queries read the
    // ledger, fixing one left the other lying and nothing turned red — the
    // same lesson as `ida-y-vuelta-cancela-la-inversion`: a cross-check
    // between two pieces that share the defect cannot see it.
    enunciado:
      'La cifra que el despacho publica sobre sí mismo es la misma que su estado de resultados',
    mutantes: [
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "const natural = CREDIT_NATURAL_TYPES.has(row.account_type) ? debitPositive.negated() : debitPositive;",
        a: "const natural = debitPositive.abs();",
        porque: 'el signo vuelve a aplicarse por FILA: una devolución sobre ventas se suma en vez de restarse y se publican 12 000 donde el informe dice 8 000',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "if (closingPolicy.enEstadoDeResultados) includeClosingIn.push('revenue', 'expense');",
        a: "includeClosingIn.push('revenue', 'expense');",
        porque: 'el asiento de cierre entra en ingresos y gastos pase lo que pase en el panel: el mes del cierre anual vuelve a publicar el ejercicio entero como actividad del mes',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "if (closingPolicy.enBalanza) includeClosingIn.push('asset', 'liability', 'equity');",
        a: "includeClosingIn.push('asset', 'liability', 'equity');",
        porque: 'la otra bandera del panel deja de leerse: la decisión contable está escrita en el panel y el código la ignora en la mitad de los tipos',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COUNT(DISTINCT je.id)::text AS transaction_count',
        a: 'COUNT(*)::text AS transaction_count',
        porque: 'el umbral de privacidad cuenta RENGLONES y no asientos: una sola póliza de diez renglones finge la multitud que el umbral promete y se publica una cifra que identifica a su dueño',
      },
      {
        archivo: 'src/services/blockchain/orchestrator.ts',
        de: 'const aggregates = await getPeriodMovementByAccountType(params.entityId, params.periodId);',
        a: "const aggregates = await getPeriodMovementByAccountType(params.entityId, params.periodId).then((r) => r.map((x) => ({ ...x, total: new Decimal(x.total).negated().toFixed(4) })));",
        porque: 'el publisher vuelve a tocar la cifra después de pedirla: lo publicado deja de ser lo que el despacho informa aunque la layer compartida esté bien',
      },
      {
        archivo: 'src/services/blockchain/orchestrator.ts',
        de: 'if (roundTo.lessThanOrEqualTo(0)) {',
        a: 'if (roundTo.lessThanOrEqualTo(-1)) {',
        porque: 'un redondeo guardado en cero —la API acepta 0.001 y la columna es DECIMAL(15,2)— vuelve a dividir entre cero y revienta con un 500 en el acto que publica las cifras del despacho',
      },
      {
        archivo: 'tests/integration/x0-published-figures-match-the-income-statement.int.spec.ts',
        de: "JournalEntryType.CLOSING",
        a: "JournalEntryType.STANDARD",
        porque: 'la reproducción deja de sembrar un asiento de cierre: el caso que publicaba −8 000 desaparece y la prueba queda verde sobre el defecto',
      },
    ],
    evaluar: () => {
      const layer = 'src/services/reporting/report-service.ts';
      const publisher = 'src/services/blockchain/orchestrator.ts';
      const spec = 'tests/integration/x0-published-figures-match-the-income-statement.int.spec.ts';
      for (const f of [layer, publisher]) if (!existe(f)) return falla(`desapareció ${f}`);

      // 1. ONE SINGLE PLACE COMPUTES THE MOVEMENT BY ACCOUNT TYPE.
      //
      // This is the criterion; the rest are its details. While there were two
      // queries, no disagreement between them could ever turn red.
      const aggregators = fuentes('src').filter((f) => {
        const t = sinComentarios(leer(f));
        return t.includes('GROUP BY a.account_type') && t.includes('journal_entry_lines');
      });
      const names = aggregators.map((f) => path.basename(f)).join(', ') || 'ninguno';
      if (aggregators.length !== 1) {
        return falla(
          `${aggregators.length} archivos agregan el mayor por tipo de cuenta (${names}): con dos, arreglar el signo en uno deja al otro publicando lo contrario y nada se pone rojo`
        );
      }
      if (!aggregators[0].endsWith('reporting/report-service.ts')) {
        return falla(
          `quien agrega el mayor por tipo de cuenta es ${names}, no la layer de informes: la cifra que se publica se calcula aparte de la que el despacho se informa a sí mismo`
        );
      }

      // 2. THE PUBLISHER ASKS FOR THE FIGURE AND DOES NOT RETOUCH IT.
      const publisherCode = codigoDe(publisher);
      if (!publisherCode.includes('const aggregates = await getPeriodMovementByAccountType(params.entityId, params.periodId);')) {
        return falla(
          'publishAggregates dejó de pedir el movimiento a la layer de informes: si vuelve a calcularlo, vuelve a poder discrepar con el estado de resultados'
        );
      }
      if (/\bSUM\s*\(\s*(jel\.)?debit/i.test(publisherCode) || /journal_entry_lines[^]*GROUP BY/i.test(publisherCode)) {
        return falla('el publisher recuperó su propia agregación del mayor: son otra vez dos cifras firmadas que pueden no coincidir');
      }
      // The privacy threshold promises a CROWD behind the figure, and a crowd
      // is counted in entries. Counting lines fakes it with a single voucher.
      if (!publisherCode.includes('const count = agg.transaction_count;')) {
        return falla('el umbral de privacidad dejó de contar asientos: contar renglones finge con una sola póliza la multitud que el umbral promete');
      }
      if (!/roundTo\.lessThanOrEqualTo\(0\)/.test(publisherCode)) {
        return falla(
          'volvió a poderse dividir entre cero al publicar: la API admite un redondeo de 0.001 y la columna es DECIMAL(15,2), así que se guarda 0.00'
        );
      }

      // 3. THE SIGN RULE AND THE PANEL POLICY, IN THAT LAYER.
      const c = codigoDe(layer);
      if (!c.includes('CREDIT_NATURAL_TYPES.has(row.account_type) ? debitPositive.negated() : debitPositive')) {
        return falla(
          'el signo dejó de aplicarse por SECCIÓN: una devolución sobre ventas es un cargo a una cuenta de ingreso, y abs() o un signo por fila la suman en vez de restarla'
        );
      }
      if (!/CREDIT_NATURAL_TYPES = new Set\(\['liability', 'equity', 'revenue'\]\)/.test(c)) {
        return falla('la lista de tipos de naturaleza acreedora cambió: el signo de lo publicado depende de ella');
      }
      if (!c.includes('COUNT(DISTINCT je.id)::text AS transaction_count')) {
        return falla('el conteo que gobierna el umbral de privacidad dejó de ser por asiento');
      }
      const byIncomeStatement = c.includes("if (closingPolicy.enEstadoDeResultados) includeClosingIn.push('revenue', 'expense');");
      const byTrialBalance = c.includes("if (closingPolicy.enBalanza) includeClosingIn.push('asset', 'liability', 'equity');");
      if (!byIncomeStatement || !byTrialBalance) {
        return falla(
          'la política de asientos de cierre dejó de leerse por sus DOS banderas: el barrido anual vuelve a poder publicarse como actividad del mes en que cae'
        );
      }
      if (!c.includes("OR NOT ${condicionDeCierre('je')}")) {
        return falla('la consulta ya no excluye los asientos de cierre donde el panel dice excluirlos: la decisión está escrita y el SQL no la aplica');
      }

      // 4. AND CONDUCT: the reproduction only proves something if it seeds the
      // three cases that disagreed. A period of natural-sign movements with no
      // closing entry publishes the same figure with the defect and without.
      if (!existe(spec)) return falla('no hay reproducción contra Postgres de lo publicado frente al estado de resultados');
      const t = crudoDe(spec);
      const needed: Array<[RegExp, string]> = [
        [/getIncomeStatement/, 'cotejar contra el estado de resultados del propio despacho, no contra una cifra escrita a mano'],
        [/public_amount/, 'leer lo que quedó PUBLICADO, no lo que la función devolvió'],
        [/JournalEntryType\.CLOSING/, 'sembrar el asiento de cierre, que es el caso que publicaba −8 000'],
        [/'4400'/, 'sembrar la devolución sobre ventas, contranatural dentro de ingresos'],
        [/'5200'/, 'sembrar la devolución sobre compras, contranatural dentro de gastos'],
      ];
      for (const [pattern, what] of needed) {
        if (!pattern.test(t)) return falla(`la reproducción dejó de ${what}`);
      }

      return ok(
        'un solo sitio agrega el mayor por tipo de cuenta; el publisher pide esa cifra sin retocarla, cuenta asientos y se niega a dividir entre cero; y la reproducción coteja lo publicado contra el estado de resultados con devoluciones en las dos secciones y con el asiento de cierre'
      );
    },
  },
  {
    paquete: 'E1.2',
    id: 'treasury-entry-date-local-midnight',
    enunciado: 'El asiento de tesorería cae en el día que ocurrió, no en la víspera',
    mutantes: [
      {
        archivo: 'src/services/banking/treasury-posting.ts',
        de: "  return new Date(`${iso}T00:00:00`);",
        a: "  return new Date(`${iso}T00:00:00Z`);",
        porque: 'vuelve la medianoche UTC: en México el asiento se fecha el día ANTERIOR, y el día 1 de mes eso lo manda al mes anterior con su IVA a otra declaración, cuadrando igual de bien',
      },
    ],
    evaluar: () => {
      // EL DEFECTO QUE CASI SE VA VIVO, y el único de F05d que era de
      // gravedad 1. `new Date('2026-06-01T00:00:00Z')` es medianoche UTC, y
      // `createJournalEntry` pasa ese Date al driver, que lo serializa en la
      // zona del PROCESO: en México (UTC−6) esa medianoche es el 31 de mayo a
      // las 18:00. El asiento se guardaba fechado un día antes Y colgado del
      // periodo fiscal de ese día.
      //
      // Medido: un cheque cobrado el 1 de junio posteaba su reclasificación de
      // IVA en MAYO — es decir, en otra declaración mensual—, y el 1 de enero
      // se lleva además el folio al ejercicio anterior. Y cuadra igual de
      // bien, que es lo que lo hacía invisible.
      //
      // Afectaba a los TRES verbos de tesorería. `treasury-posting.ts` era el
      // único de los cuatro sitios del sistema que crean asientos desde una
      // fecha ISO que lo hacía en UTC.
      const t = codigoDe('src/services/banking/treasury-posting.ts');
      if (!/function fechaDelAsiento\(/.test(t)) {
        return falla('desapareció el constructor único de la fecha del asiento: cada verbo volvería a fabricarla por su cuenta');
      }
      if (/new Date\(`\$\{[a-zA-Z.]+\}T00:00:00Z`\)/.test(t)) {
        return falla('volvió la medianoche UTC: el asiento se fecharía un día antes, y el día 1 de mes eso es el mes anterior');
      }
      // Y LO USAN LOS TRES. Que exista el helper no sirve si un verbo se lo
      // salta: el defecto original era exactamente un sitio de cuatro.
      const usos = (t.match(/fechaDelAsiento\(/g) ?? []).length;
      return usos >= 4
        ? ok('la fecha del asiento la construye un solo sitio, en medianoche local, y los tres verbos la usan')
        : falla(
            `sólo ${usos - 1} verbo(s) de tesorería usan el constructor de fecha: el que se lo salte volverá a fechar en la víspera`
          );
    },
  },

  {
    paquete: 'E1.2',
    id: 'treasury-posting-matches-its-movement',
    enunciado: 'Contabilizar una comisión ata su movimiento, o el mismo cargo se cuenta dos veces',
    mutantes: [
      {
        archivo: 'src/services/banking/treasury-posting.ts',
        de: '      await cotejarMovimientoConSuLinea(client, {',
        a: '      await Promise.resolve({',
        porque: 'el cargo contabilizado vuelve a levantar DOS partidas conciliatorias que se anulan entre sí: la sesión informa que cuadra y la comisión se puede contabilizar otra vez',
      },
    ],
    evaluar: () => {
      // `clasificarPartidas` y `movimientosSinExplicar` preguntan por COTEJOS
      // VIVOS, no por la caché `is_matched`. Un cargo contabilizado sin cotejo
      // levantaba `cargo-del-banco` del lado del banco y su gemela del lado de
      // libros: el MISMO hecho contado dos veces, anulándose. Medido, un cargo
      // de −348 daba dos partidas por −696 y la sesión decía `cuadra: true` —
      // y sobre esa base la comisión se podía contabilizar por segunda vez,
      // porque la segunda partida absorbía el desvío.
      //
      // La única defensa era acordarse de correr el motor de cotejo antes de
      // clasificar. Un invariante que depende de que alguien recuerde un paso
      // no es un invariante.
      const t = codigoDe('src/services/banking/treasury-posting.ts');
      if (!/async function cotejarMovimientoConSuLinea\(/.test(t)) {
        return falla('desapareció el cotejo que ata el movimiento a la línea que lo explica');
      }
      // LOS DOS VERBOS que crean línea contra el banco lo llaman: la comisión y
      // el interés. Se CUENTAN porque son gemelos y anclar «alguna» llamada
      // dejaría vivo al que rompa el otro.
      const llamadas = (t.match(/await cotejarMovimientoConSuLinea\(/g) ?? []).length;
      if (llamadas < 2) {
        return falla(
          `sólo ${llamadas} de los 2 verbos que crean línea de banco atan su movimiento: el que no lo ate lo levantará dos veces`
        );
      }
      // Y EL OTRO LADO LO RESPETA: una línea con cotejo vivo está explicada
      // aunque el sello aún no esté puesto. Sin esto, la línea de la comisión
      // seguía saliendo como partida hasta contabilizar la sesión.
      const libros = /rm\.matched_entity_type = 'journal_entry_line'[\s\S]{0,200}?rm\.unapplied_at IS NULL/.test(
        codigoDe('src/services/banking/reconciling-items.ts')
      );
      return libros
        ? ok('los dos verbos atan su movimiento y un cotejo vivo explica la línea aunque el sello llegue después')
        : falla('el clasificador volvió a juzgar la partida de libros sólo por el sello: la línea ya cotejada seguiría levantándose');
    },
  },

  {
    paquete: 'E1.2',
    id: 'reconciling-item-datable-and-correctable',
    enunciado: 'La partida conciliatoria se puede fechar y corregir, o `close` es inalcanzable',
    mutantes: [
      {
        archivo: 'src/cli/bank-command.ts',
        de: "    .command('assign')",
        a: "    .command('assign-x')",
        porque: 'sin la hoja que fecha una partida, `close` exige una fecha que nadie puede escribir y la primera sesión con una partida queda bloqueada para siempre',
      },
    ],
    evaluar: () => {
      // EL HUECO QUE F05C TUVO QUE CERRAR AÑADIENDO FILAS AL CATÁLOGO.
      // `close` exige toda partida CLASIFICADA Y FECHADA;
      // `clasificarPartidas` levanta toda partida sin fecha —a propósito: nada
      // en el extracto sabe cuándo se cobrará un cheque—; y el catálogo
      // publicaba «responsable, fecha esperada y escalamiento» en el listado
      // sin dar forma de fijar ninguno. La primera sesión con una sola partida
      // se quedaba bloqueada para siempre, y cuatro de los seis tipos —los dos
      // errores entre ellos— eran inalcanzables, porque el signo no distingue
      // una comisión de un error del banco.
      const cli = codigoDe('src/cli/bank-command.ts');
      const svc = codigoDe('src/services/banking/reconciling-items.ts');

      const faltan = ['asignarPartida', 'reclasificarPartida'].filter(
        (f) => !new RegExp(`export async function ${f}\\(`).test(svc)
      );
      if (faltan.length > 0) {
        return falla(`el servicio perdió ${faltan.join(', ')}: no habría con qué fechar ni corregir una partida`);
      }
      // Y CON PUERTA. Los dos existían, estaban probados, y ninguno tenía
      // comando: es la forma exacta de «verde no es entregado».
      const conPuerta = ['assign', 'correct'].filter((v) =>
        new RegExp(`\\.command\\('${v}'\\)`).test(cli)
      );
      return conPuerta.length === 2
        ? ok('fechar y corregir una partida tienen servicio Y hoja: `close` es alcanzable desde el binario')
        : falla(
            `de las dos hojas que desbloquean \`close\` sólo hay ${conPuerta.length}: sin ellas, la primera sesión con una partida no se cierra nunca`
          );
    },
  },

  {
    paquete: 'E1.2',
    id: 'reconciliation-session-covers-period',
    enunciado: 'La casilla del cierre exige que la sesión CUBRA el periodo, no que termine después',
    mutantes: [
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: '       AND rs.start_date <= (SELECT start_date FROM fiscal_periods WHERE id = $2)',
        a: '       AND true',
        porque: 'la sesión de septiembre volvería a tildar la casilla de agosto: la casilla diría «conciliado» sobre un mes que nadie miró',
      },
    ],
    evaluar: () => {
      // `period-close.ts` lee una sesión balanceada como la evidencia de que la
      // cuenta se verificó contra el banco. Su predicado era «alguna sesión
      // balanceada que TERMINE después del cierre», y con eso la de septiembre
      // tildaba la de agosto —30/09 es posterior a 31/08— aunque agosto no se
      // hubiera conciliado nunca.
      //
      // Importa más desde F05c que antes: hasta este tramo la casilla mentía
      // por su ORIGEN, porque `balanced` se ponía sin aritmética. Ahora
      // `balanced` se gana, así que lo único que puede estropearla es leerla
      // mal. Una afirmación que se vuelve cierta merece un lector que no la
      // arruine.
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const cubre =
        /AND rs\.start_date <= \(SELECT start_date FROM fiscal_periods WHERE id = \$2\)/.test(pc) &&
        /AND rs\.end_date\s+>= \(SELECT end_date\s+FROM fiscal_periods WHERE id = \$2\)/.test(pc);
      return cubre
        ? ok('la casilla exige una sesión que cubra el periodo por los dos extremos')
        : falla('la casilla del cierre volvió a conformarse con una sesión que termine después: un mes sin conciliar se tildaría con la conciliación del siguiente');
    },
  },

  // ---- F05b · Los dos lados y el cotejo ----

  {
    paquete: 'E1.2',
    id: 'text-similarity-never-auto-applies',
    enunciado: 'Ningún cotejo se aplica solo cuando su única señal es el parecido del texto',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '  if (!result.auto_applicable) return false;',
        a: '  if (false) return false;',
        porque: 'la compuerta deja de mirar el veto de la regla: un desempate decidido por la descripción vuelve a aplicarse en firme y a sellar la partida de libros',
      },
      {
        archivo: 'src/services/banking/matching.ts',
        de: '        auto_applicable: importeExacto && empatanEnImporte === 1,',
        a: '        auto_applicable: true,',
        porque: 'la regla que desempata por texto se autoriza a sí misma: es exactamente lo que el catálogo prohíbe en la fila 1225',
      },
    ],
    evaluar: () => {
      // «Nunca aplica un cotejo cuya única señal sea similitud de descripción»
      // es una promesa LITERAL del catálogo (fila 1225), y estaba viva al
      // revés: la regla marcaba su hallazgo como no-aplicable y el servicio
      // NUNCA LEÍA esa marca. Medido: dos facturas del mismo importe y la
      // misma fecha, desempatadas por el texto, se aplicaban en firme y
      // sellaban la partida.
      //
      // Por eso el veto se ancla en las DOS mitades: quien lo pone y quien lo
      // obedece. Anclar sólo una deja pasar el defecto original, que era
      // exactamente una mitad sin la otra.
      const motor = codigoDe('src/services/banking/matching.ts');
      const svc = codigoDe('src/services/banking/match-service.ts');

      // 1. La regla que desempata por texto NO se autoriza: su `auto_applicable`
      //    depende de que el importe sea exacto y de que nadie más empate.
      if (!/auto_applicable: importeExacto && empatanEnImporte === 1,/.test(motor)) {
        return falla('la regla de similitud dejó de vetarse: puede volver a decidir sola un desempate que las reglas duras rechazaron');
      }
      // 2. Y la compuerta lo OBEDECE. Es la mitad que faltaba.
      if (!/if \(!result\.auto_applicable\) return false;/.test(motor)) {
        return falla('la compuerta de aplicación dejó de leer el veto de la regla: el motor lo pone y nadie lo mira, que es el defecto original');
      }
      // 3. Y la omisión tiene MOTIVO CONTABLE, no un silencio: una causa que no
      //    se puede contar no se puede corregir.
      const motivo = /'solo-similitud',/.test(svc);
      return motivo
        ? ok('la regla de texto se veta a sí misma, la compuerta obedece el veto y la omisión se cuenta con su motivo')
        : falla('desapareció el motivo «solo-similitud»: la omisión ocurriría en silencio y nadie podría contarla');
    },
  },

  {
    paquete: 'E1.2',
    id: 'book-item-bank-account-scoped',
    enunciado: 'Una partida de libros sólo se coteja si es de la cuenta de mayor del banco',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '       AND jel.account_id = $4',
        a: '       AND jel.account_id IS NOT NULL',
        porque: 'el motor vuelve a proponer CUALQUIER línea posteada de la entidad: sellaría un gasto de renta como conciliado contra un banco que nunca lo vio, y esa línea queda inservible para la conciliación que sí le tocaba',
      },
    ],
    evaluar: () => {
      // `getCandidates` no filtraba por `jel.account_id`: devolvía cualquier
      // línea posteada sin sellar de la entidad que cayera en la banda de
      // importe. Medido: un depósito de 300 sellaba la línea de RENTA de una
      // póliza que no tocaba el banco. Y el sello es irreversible en la
      // práctica —esa línea ya no volvería a ofrecerse a su conciliación real—.
      //
      // Lo que lo delata como defecto y no como criterio: `bank book-item list`
      // SÍ unía por `ba.gl_account_id` desde el primer día. Los dos lados del
      // mismo tramo discrepaban sobre qué es una partida de libros.
      const motor = codigoDe('src/services/banking/matching.ts');
      const libros = codigoDe('src/services/banking/book-items.ts');

      if (!/AND jel\.account_id = \$\d/.test(motor)) {
        return falla('el motor volvió a proponer líneas de póliza ajenas a la cuenta del banco: sellarlas las inutiliza para su conciliación real');
      }
      // Y EL OTRO LADO USA LA MISMA DEFINICIÓN. Que las dos superficies
      // coincidan es lo que hace que el cotejo signifique algo.
      const mismoLado = /ba\.gl_account_id/.test(libros);
      return mismoLado
        ? ok('el motor y el listado de partidas de libros coinciden en qué es una partida: la cuenta de mayor del banco')
        : falla('el listado de partidas de libros dejó de unir por la cuenta de mayor del banco: los dos lados del cotejo volverían a discrepar');
    },
  },

  {
    paquete: 'E1.2',
    id: 'match-candidate-uses-open-balance',
    enunciado: 'Una factura cobrada a medias puede casar, porque el candidato se compara contra su saldo',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: "`SELECT id, 'invoice' as type, amount_due as amount, invoice_date as date,",
        a: "`SELECT id, 'invoice' as type, total_amount as amount, invoice_date as date,",
        porque: 'vuelve el defecto: se filtra por el saldo y se compara contra el total, así que una factura parcialmente cobrada no puede casar jamás — y es el caso más común de una conciliación real',
      },
    ],
    evaluar: () => {
      // `getCandidates` FILTRABA por `ABS(amount_due) BETWEEN $2 AND $3` y
      // PROYECTABA `total_amount as amount`: una factura con saldo 500 y total
      // 1160 entraba en el rango por su saldo y después el motor la comparaba
      // contra 1160. El resultado no era que casara mal — es que **no podía
      // casar nunca**, en silencio y para siempre.
      const motor = codigoDe('src/services/banking/matching.ts');
      const proyecta = (motor.match(/amount_due as amount/g) ?? []).length;
      // DOS: la factura y el gasto. Son gemelos y el mutante muta el primero;
      // buscar «alguna» ocurrencia encontraría el otro y daría verde.
      return proyecta === 2
        ? ok('los dos candidatos —factura y gasto— se comparan contra su saldo, que es por lo que se los filtró')
        : falla(
            `${proyecta} de 2 candidatos se proyectan por su saldo: el que se filtre por saldo y se compare contra el total no podrá casar nunca`
          );
    },
  },

  // ---------------------------------------------------------------
  // S4 · MUTANTE 5/6 · LA VENTANA DEL COTEJO, Y LAS DOS VARAS
  //
  // El issue #109 manda sembrar «la ventana del cotejo». La conducta SÍ estaba
  // fijada —`matching.spec.ts` prueba que a tres días casa y a cuatro ya no—
  // pero el ARNÉS no podía declararla: `scripts/mutantes.ts` aplica el espejo y
  // llama a `criterio.evaluar()`, y nunca corre vitest. Una prueba verde o roja
  // le es invisible: sin criterio que lea este número, el mutante salía VIVO.
  //
  // Y afirma DOS cosas porque con una sola se vacía. Si sólo mirara el motor,
  // mover las dos varas a treinta días pasaría; si sólo mirara la CLI, quedaría
  // sin dueño la divergencia entre superficies, que es la que el docblock de
  // `match-service.ts` promete que no existe.
  // ---------------------------------------------------------------
  {
    paquete: 'E1.2',
    id: 'near-date-window-agrees-across-engines',
    enunciado:
      'La ventana que vuelve dura a la señal de fecha no pasa de tres días, y las dos superficies del cotejo miden la misma',
    evaluar: () => {
      const motor = codigoDe('src/services/banking/matching.ts');
      const cli = codigoDe('src/services/banking/match-service.ts');
      const enMotor = /const threeDays = (\d+) \* 24 \* 60 \* 60 \* 1000;/.exec(motor);
      const enCli = /const MATCH_WINDOW_DAYS = (\d+);/.exec(cli);
      if (enMotor === null) {
        return falla('la regla 2 del motor dejó de declarar su ventana como un número legible');
      }
      if (enCli === null) return falla('match-service dejó de declarar su ventana como un número legible');
      const engineDays = Number(enMotor[1]);
      const cliDays = Number(enCli[1]);
      if (engineDays > 3) {
        return falla(
          `la ventana de la regla 2 subió a ${engineDays} días: a esa distancia el importe exacto queda ` +
            'como ÚNICA señal, y esa regla se aplica EN FIRME. Dos pagos iguales del mismo ' +
            'proveedor en el mismo mes dejan de distinguirse'
        );
      }
      if (engineDays !== cliDays) {
        return falla(
          `el motor mide ${engineDays} día(s) y match-service ${cliDays}: la CLI informaría «dentro de ` +
            'ventana» con una vara y el REST aplicaría con otra'
        );
      }
      return ok(`la ventana es de ${engineDays} día(s) y las dos superficies la comparten`);
    },
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '    const threeDays = 3 * 24 * 60 * 60 * 1000;',
        a: '    const threeDays = 30 * 24 * 60 * 60 * 1000;',
        porque:
          'la ventana se ensancha a un mes: a esa distancia el importe exacto es la única señal y la ' +
          'regla 2 aplica EN FIRME, así que dos pagos iguales del mismo proveedor se confunden',
      },
      {
        archivo: 'src/services/banking/match-service.ts',
        de: 'const MATCH_WINDOW_DAYS = 3;',
        a: 'const MATCH_WINDOW_DAYS = 7;',
        porque:
          'las dos superficies dejan de medir lo mismo: la CLI diría «dentro de ventana» de un ' +
          'candidato que el motor no considera cercano',
      },
    ],
  },

  // ---------------------------------------------------------------
  // S4 · MUTANTE 6/6 · LA TOLERANCIA DEL COTEJO, QUE ESTABA VIVO
  //
  // De los seis que el issue manda sembrar, éste era el único VIVO:
  // `times(0.05)` → `times(0.95)` dejaba 5 516 pruebas en verde. La razón, al
  // leerlas: las dos pruebas de la regla 3 usaban importes DENTRO de la banda
  // —1020 contra 1000 es un 2 %, y el otro exacto—, así que abrirla no cambiaba
  // ninguno de los dos veredictos. Nadie probaba el borde.
  //
  // QUÉ SE PIERDE AL ABRIRLA. No es una escritura automática: `auto_applicable`
  // exige importe idéntico al centavo y se calcula fuera de la banda. Lo que se
  // corrompe es LA PROPUESTA QUE UN HUMANO FIRMA. Y `getCandidates` ya acota a
  // ±10 % en la base, así que el daño real no es «1 000 casa con 60» sino esto:
  // un candidato al 8 % que hoy no nombra nadie —la regla 4 se queda en 0.64,
  // bajo su 0.75— pasa a salir como `fuzzy_description` con confianza 1.00. Un
  // «no sé» convertido en un nombre seguro y equivocado.
  //
  // EL CRITERIO AFIRMA DOS COSAS: la cifra, cerrada por la derecha; y que la
  // prueba del borde siga existiendo. Sin la segunda se quedaría verde sobre
  // una banda que ninguna prueba toca, que es como éste llegó a estar vivo.
  // ---------------------------------------------------------------
  {
    paquete: 'E1.2',
    id: 'fuzzy-match-band-is-narrow-and-tested',
    enunciado:
      'La banda de importe del cotejo difuso es del 5 %, y hay prueba que fija su borde por fuera',
    evaluar: () => {
      const motor = codigoDe('src/services/banking/matching.ts');
      // SIN EL COMENTARIO EN EL ANCLA: `codigoDe` quita los comentarios antes de
      // entregar el texto, así que exigir el «// 5% tolerance» del final ponía
      // este criterio rojo sobre un archivo perfectamente sano. Es la regla que
      // este archivo se aplica a sí mismo desde E0.1.
      const banda = /const amountTolerance = txAmount\.times\((0\.\d+)\);/.exec(motor);
      if (banda === null) {
        return falla(
          'la regla 3 dejó de declarar su banda de importe como una cifra legible: sin ella, lo ' +
            'único que separa a un candidato de otro es el parecido del texto'
        );
      }
      if (Number(banda[1]) > 0.05) {
        return falla(
          `la banda del cotejo difuso subió al ${(Number(banda[1]) * 100).toFixed(0)} %: el parecido ` +
            'de la descripción pasa a rescatar candidatos cuyo importe ya había dicho que no, y el ' +
            'motor nombra con confianza 1.00 lo que hoy contesta «no sé»'
        );
      }
      const spec = crudoDe('tests/services/banking/matching.spec.ts');
      if (!/amount: '1080\.0000'/.test(spec)) {
        return falla(
          'desapareció la prueba del candidato FUERA de la banda: sin un importe que la banda tenga ' +
            'que rechazar, ensancharla no pone roja ninguna prueba'
        );
      }
      return ok('la banda es del 5 % y hay prueba que la fija por fuera, a un 8 % de distancia');
    },
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '    const amountTolerance = txAmount.times(0.05); // 5% tolerance',
        a: '    const amountTolerance = txAmount.times(0.95); // 5% tolerance',
        porque:
          'el espejo que este tramo encontró VIVO: la banda deja de acotar y un candidato que hoy ' +
          'nadie nombra sale como cotejo con confianza 1.00',
      },
      {
        archivo: 'tests/services/banking/matching.spec.ts',
        de: "candidato({ amount: '1080.0000' })",
        a: "candidato({ amount: '1000.0000' })",
        porque:
          'la prueba del borde deja de estar fuera de la banda: volvería a pasar con la tolerancia ' +
          'abierta, que es como el mutante de la banda sobrevivió hasta hoy',
      },
    ],
  },

  // ---------------------------------------------------------------
  // S4 · EL MANUAL DEL AGENTE DICE LO QUE EL CLASIFICADOR HACE
  //
  // `mexico-cfdi.md` enseñaba «PUE → the expense is credited against BANKS»
  // mientras `cfdi-taxonomy.ts` abona a `cxp` en LOS DOS casos recibidos, y su
  // propia nota advierte que abonar al banco DUPLICARÍA la salida cuando llegue
  // el movimiento bancario. Un agente que siguiera el manual redactaba el
  // asiento al revés, y el error sólo aparecía al conciliar.
  //
  // Y ESTABA SELLADO COMO REVISADO. `corpus-manifiesto` compara el sha de la
  // FUENTE: caza que el código cambió bajo un manual, no que el manual nunca
  // fue cierto. Uno que nace equivocado pasa esa compuerta para siempre. Por
  // eso este criterio no mira el sello: cruza la afirmación NORMATIVA con el
  // código que la ejecuta.
  //
  // No valida el manual entero —eso no lo hace un regex—. Ata la única
  // afirmación cuyo error se paga dos veces en el mayor.
  // ---------------------------------------------------------------
  {
    paquete: 'E1.2',
    id: 'cfdi-manual-credits-what-the-classifier-credits',
    enunciado:
      'El manual del agente no manda abonar al banco un CFDI recibido, porque el clasificador abona a proveedores',
    evaluar: () => {
      const manual = crudoDe('src/ai/docs/mexico-cfdi.md');
      const taxonomia = codigoDe('src/services/xml-ingestion/cfdi-taxonomy.ts');

      for (const kind of ['ingreso_recibido_pue', 'ingreso_recibido_ppd']) {
        const i = taxonomia.indexOf(`id: '${kind}'`);
        if (i === -1) return falla(`el clasificador perdió el caso ${kind}`);
        const cuerpo = taxonomia.slice(i, i + 2200);
        if (!/role: 'cxp', side: 'credit'/.test(cuerpo)) {
          return falla(
            `${kind} dejó de abonar a 'cxp'. Si abona al banco, la salida de efectivo se cuenta dos ` +
              'veces: una aquí y otra al conciliar el extracto'
          );
        }
      }

      if (/credited against BANKS/i.test(manual)) {
        return falla(
          'mexico-cfdi.md vuelve a mandar abonar al banco un CFDI recibido, y el clasificador abona ' +
            'a proveedores: el agente redactaría el asiento al revés y el error sólo aparecería al ' +
            'conciliar, duplicada ya la salida'
        );
      }
      if (!/NEVER BANKS/i.test(manual)) {
        return falla(
          'el manual dejó de decir expresamente que no se abona al banco. La compuerta del corpus no ' +
            'lo caza: compara el sha de la FUENTE, no si el manual es cierto'
        );
      }
      return ok('el manual manda abonar a proveedores, que es lo que los dos casos recibidos hacen');
    },
    mutantes: [
      {
        archivo: 'src/ai/docs/mexico-cfdi.md',
        de: 'BOTH PUE AND PPD CREDIT VENDORS (AP), NEVER BANKS.',
        a: 'PUE (single-payment) → the expense is credited against BANKS.',
        porque:
          'el manual vuelve al texto que mal-instruía: el agente abona al banco y la salida se cuenta ' +
          'dos veces cuando llega el movimiento',
      },
      {
        archivo: 'src/services/xml-ingestion/cfdi-taxonomy.ts',
        de: "{ role: 'cxp', side: 'credit', amount: A.total, description: 'Vendor' },",
        a: "{ role: 'banco', side: 'credit', amount: A.total, description: 'Vendor' },",
        porque:
          'el clasificador se va al banco y el manual se queda diciendo proveedores: la pareja tiene ' +
          'que acusar el desacuerdo venga del lado que venga, y éste es el lado que duplica la salida',
      },
    ],
  },




  // ---- F06b · El cierre deja de mirar por la ventana equivocada ----

  {
    paquete: 'E1.2',
    id: 'close-checklist-period-scoped',
    enunciado: 'El checklist del cierre mira su propio periodo, consume el mayor y no fabrica veredictos ajenos',
    mutantes: [
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: '        AND document_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)',
        a: '        AND document_date IS NOT NULL',
        porque: 'vuelve el vicio de F05c en su forma pura: un CFDI pendiente de NOVIEMBRE bloquearía el cierre de AGOSTO, porque la casilla contaría sin filtro de periodo',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerClosingCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerClosingCommand fuera del binario',
        porque: 'cuarta repetición del defecto de la casa: la lectura del cierre pasa sus pruebas sobre un programa que sólo construye el spec, y el binario no la carga',
      },
    ],
    evaluar: () => {
      // TRES MENTIRAS DEL CHECKLIST, cerradas en F06b y ancladas aquí:
      const pc = codigoDe('src/services/accounting/period-close.ts');

      // 1. Cada casilla mira SU periodo. La de pre-registros contaba sin
      //    filtro de fecha — el vicio que F05c cazó en la de banco, en su
      //    forma pura: lo pendiente de noviembre ensuciaba el cierre de agosto.
      if (!/AND document_date BETWEEN \(SELECT start_date FROM fiscal_periods WHERE id = \$2\)/.test(pc)) {
        return falla('la casilla de pre-registros volvió a contar sin filtro de periodo: lo pendiente de otro mes ensuciaría este cierre');
      }
      // 2. El cierre CONSUME el mayor. runLedgerChecks existía y sólo lo
      //    llamaban el comando de ledger y el verificador de respaldo: un
      //    periodo podía cerrarse con el mayor descuadrado sin que ninguna
      //    casilla lo mirara.
      if (!/runLedgerChecks/.test(pc)) {
        return falla('el checklist dejó de correr los chequeos del mayor: un periodo podría cerrarse descuadrado');
      }
      // 3. La secuencia: el hueco más viejo, no sólo el vecino. Mirar sólo el
      //    inmediato anterior hacía invisible reabrir enero detrás de un
      //    febrero cerrado — el hueco quedaba tapado al cerrar marzo.
      if (!/'previous-period-closed'/.test(pc)) {
        return falla('desapareció la casilla de secuencia: cerrar octubre con septiembre abierto volvería a pasar en silencio');
      }
      // 4. Y NO SE FABRICAN VEREDICTOS AJENOS: el periodo se resuelve por
      //    PERTENENCIA (serie TEN) antes de contestar. `explainCloseCheck` de
      //    la entidad A sobre el periodo de B devolvía «0 ofensores» limpio, y
      //    la ruta REST servía can_close:true sobre un UUID inventado.
      const guard = /throw new NotFoundError\('Fiscal period', periodId\)/.test(pc);
      const entregada = /registerClosingCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      if (!guard) {
        return falla('el checklist volvió a contestar sobre periodos que no son de la entidad: un UUID inventado recibiría can_close verdadero');
      }
      return entregada
        ? ok('cada casilla mira su periodo, el mayor se consume, la secuencia se vigila desde el hueco más viejo, la pertenencia se exige y la familia está en el binario')
        : falla('registerClosingCommand no está en el binario: la lectura del cierre quedó verificada y no entregada');
    },
  },

  // ---- F06c · El lote importado por fin se puede aplicar ----

  {
    paquete: 'E1.2',
    id: 'import-batch-respects-state-flow',
    enunciado: 'El lote respeta su flujo —staged, checked, posted— y se reversa como unidad',
    mutantes: [
      {
        // El diente, no la boca. La primera versión mutaba la APERTURA de la
        // función añadiendo `return;` — el throw quedaba como código muerto y
        // toda ancla textual seguía encontrándolo. Un criterio de texto no ve
        // código muerto: hay que mutar lo que se ancla.
        archivo: 'src/services/accounting/batch-service.ts',
        de: '  if (permitidos.includes(lote.status)) return;',
        a: '  return;',
        porque: 'la guarda deja pasar TODO estado: un lote staged se postearía sin verificar, que es exactamente lo que el flujo de la 045 existe para impedir',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerBatchCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerBatchCommand fuera del binario',
        porque: 'tercera repetición del defecto de la casa: la familia pasa sus 72 pruebas sobre un programa que sólo construye el spec, y el staging de F01 vuelve a no tener salida',
      },
    ],
    evaluar: () => {
      // F01 dejó una puerta de entrada a un almacén sin salida: `entry import`
      // deposita pólizas en el staging de la 045 y hasta F06c ningún comando
      // podía aplicarlas, verificarlas ni reversarlas. El flujo
      // staged→checked→posted del CHECK de la 045 era un dibujo.
      const svc = codigoDe('src/services/accounting/batch-service.ts');

      // 1. La guarda de estado existe y es ÚNICA: cada verbo la llama en vez de
      //    comparar por su cuenta, que es como las máquinas de estados se
      //    desincronizan.
      // Se ancla el CUERPO de la guarda —la condición Y el throw—, no su
      // nombre: una guarda que existe y no muerde es la forma exacta del
      // mutante que sobrevivió a la primera versión de este criterio.
      if (!/if \(permitidos\.includes\(lote\.status\)\) return;[\s\S]{0,200}?throw new ConflictError\(/.test(svc)) {
        return falla('la guarda de estado del lote perdió su diente: existe pero deja pasar, y un lote staged se postearía sin verificar');
      }
      const usos = (svc.match(/exigirEstado\(/g) ?? []).length;
      if (usos < 4) {
        return falla(`sólo ${usos - 1} verbos pasan por la guarda de estado: el que no pase podrá saltarse el flujo`);
      }
      // 2. El origen propio: las pólizas del lote se distinguen de las
      //    manuales, y la reversa encuentra EXACTAMENTE las suyas.
      if (!/ORIGEN_LOTE_IMPORTADO = 'import_batch'/.test(svc)) {
        return falla('las pólizas del lote perdieron su origen propio: la reversa no sabría cuáles son suyas y los informes las contarían como manuales');
      }
      // 3. La reversa en bloque usa la transacción del llamador — N espejos,
      //    todo o nada — y no N transacciones sueltas.
      const enBloque = /await reverseWithinTransaction\(/.test(svc);
      // 4. Y está en el binario: tercera vez que una familia entera pasa sus
      //    pruebas sin que mnemosine la cargue.
      const entregada = /registerBatchCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      if (!enBloque) {
        return falla('la reversa del lote dejó de usar la transacción compartida: N espejos en N transacciones puede dejar medio lote reversado');
      }
      return entregada
        ? ok('la guarda de estado es única y la usan todos los verbos, el origen es propio, la reversa es todo-o-nada y la familia está en el binario')
        : falla('registerBatchCommand no está en el binario: el staging de F01 vuelve a ser un almacén sin salida');
    },
  },

  // ---- F07c+d · La DIOT, las pólizas y el índice que actualiza ----

  {
    paquete: 'E1.2',
    id: 'dirty-value-fails-one-row',
    enunciado: 'Un dato sucio ensucia su renglón y no el archivo del mes, y un factor de INPC no cruza bases',
    mutantes: [
      {
        // La negativa que sostiene el módulo del INPC. El INEGI ha rebasado
        // la serie varias veces, y dividir un índice de una base entre otro
        // de otra base da un número PLAUSIBLE y sin significado — que es lo
        // peligroso: un factor absurdo se ve, uno plausible se firma.
        archivo: 'src/services/fiscal/inpc/factor.ts',
        de: '  if (baseAntiguo !== baseReciente) {',
        a: '  if (false) {',
        porque: 'el factor de actualización vuelve a cruzar bases distintas del INPC: sale un número creíble, se usa para deducir inversiones actualizadas y nadie lo nota hasta una revisión',
      },
      {
        // La tesis de F07d: el constructor no distingue «esta póliza» de
        // «este archivo», así que una sola fila sucia mataba el mes entero
        // — justo en el comando cuyo producto es la lista de lo que falta.
        archivo: 'src/services/sat/anexo24/polizas-service.ts',
        de: 'type Saneador = (crudo: string, numUnIdenPol: string, campo: string) => string;',
        a: 'type Saneador = (crudo: string) => string;',
        porque: 'el saneador pierde la póliza y el campo que está limpiando: el aviso deja de decir DÓNDE estaba el dato sucio, y un archivo de cientos de pólizas vuelve a denunciar sin señalar',
      },
    ],
    evaluar: () => {
      const factor = codigoDe('src/services/fiscal/inpc/factor.ts');
      const pol = codigoDe('src/services/sat/anexo24/polizas-service.ts');
      const diot = codigoDe('src/services/sat/diot/rfc.ts');

      // 1. EL INPC NO CRUZA BASES. Es la única aritmética de este tramo cuyo
      //    error no se ve: el resultado sigue siendo un número con pinta de
      //    factor. Por eso la 065 metió la base en la LLAVE.
      if (!/baseAntiguo !== baseReciente/.test(factor) || !/INPC_BASES_DISTINTAS/.test(factor)) {
        return falla('el factor del INPC volvió a admitir bases distintas: el número que devuelve es plausible, se firma, y no significa nada');
      }
      // 2. EL DATO SUCIO ENSUCIA SU RENGLÓN, NO EL ARCHIVO. El saneador lleva
      //    la póliza y el campo consigo para que el aviso señale, y no sólo
      //    denuncie: en un archivo de cientos, «hay un dato sucio» no es una
      //    ayuda, es una búsqueda.
      // Se cuentan las DOS: el tipo del saneador y la implementación que lo
      // cumple. Anclar la firma a secas dejaba vivo el mutante, porque la
      // implementación repite la misma lista de parámetros y la presencia
      // seguía siendo cierta con el tipo ya mutilado. Es la cuarta vez en
      // este proyecto que un gemelo textual salva a un mutante.
      const saneadorConSitio = (pol.match(/numUnIdenPol: string, campo: string/g) ?? []).length;
      if (saneadorConSitio !== 2) {
        return falla(
          `el saneador de pólizas perdió el sitio en ${2 - saneadorConSitio} de sus dos mitades: ` +
            'el aviso vuelve a no señalar qué póliza y qué campo llevaban el dato sucio'
        );
      }
      // 3. Y EL RFC SE JUZGA ANTES DE CONSTRUIR. `vendors.tax_id` es texto
      //    libre sin CHECK: un RFC de once caracteres reventaba el archivo
      //    desde el nodo del comprobante, y viajaba sin comprobar por el del
      //    pago. Decidir antes de construir es lo que convierte un archivo
      //    muerto en un renglón con su motivo.
      const rfcAntes = /export function rfcDeclarable/.test(diot) || /rfcDeclarable/.test(pol);
      return rfcAntes
        ? ok('el INPC se niega a cruzar bases, el dato sucio se denuncia con su póliza y su campo, y el RFC se juzga antes de construir el XML')
        : falla('el RFC volvió a comprobarse dentro del constructor: un RFC inválido mata el archivo del mes en vez de caer su renglón con su motivo');
    },
  },

  // ---- F07a · Los cimientos del Anexo 24 ----

  {
    paquete: 'E1.2',
    id: 'sat-grouping-code-single-column',
    enunciado: 'El agrupador del SAT vive en una sola columna, y la balanza publica su saldo inicial y sus descuadres',
    mutantes: [
      {
        // El okupa: el agrupador FISCAL vivía en la casilla de la norma
        // CONTABLE, hermana de us_gaap_code e ifrs_code. Funcionaba mientras
        // nadie usara la otra; el día que una entidad necesitara ambas, una
        // pisaba a la otra en silencio.
        archivo: 'src/services/accounting/account-service.ts',
        de: "  'sat-agrupador': 'codigo_agrupador_sat',",
        a: "  'sat-agrupador': 'mx_nif_code',",
        porque: 'devuelve el agrupador fiscal a la columna de presentación contable: el código NIF y el del SAT vuelven a pisarse, y el catálogo del Anexo 24 se construye sobre la casilla equivocada',
      },
      {
        // Lo que el adversarial cazó: el servicio calculaba los descuadres
        // —el recálculo que la AUTORIDAD rehace sobre el archivo sellado— y
        // las tres superficies los tiraban. La balanza se imprimía con cara
        // de correcta.
        archivo: 'src/api/rest/routes/reports.ts',
        de: '      ...(report.inicial ? { opening_balance: report.inicial } : {}),',
        a: '      // sin el sobre del saldo inicial',
        porque: 'la API vuelve a tirar la procedencia del saldo inicial, si es firme y los descuadres: el consumidor recibe una balanza que parece correcta sobre cuentas que no cuadran',
      },
    ],
    evaluar: () => {
      const cta = codigoDe('src/services/accounting/account-service.ts');
      const rest = codigoDe('src/api/rest/routes/reports.ts');
      const cierre = codigoDe('src/services/accounting/period-close.ts');

      // 1. UNA SOLA VERDAD. El esquema 'sat-agrupador' escribe en la columna
      //    que la 037 creó para eso, no en la de norma contable.
      if (!/'sat-agrupador': 'codigo_agrupador_sat'/.test(cta)) {
        return falla('el agrupador del SAT volvió a la columna de presentación contable: dos cosas distintas compartiendo casilla, que es como llegó aquí');
      }
      // 2. LA CUARTA COLUMNA LLEGA A LA SUPERFICIE. El SAT recalcula
      //    SaldoIni + Debe − Haber = SaldoFin sobre lo que se le entrega, así
      //    que un descuadre calculado y no publicado es peor que no
      //    calcularlo: nadie lo mira y la balanza sale con cara de correcta.
      if (!/opening_balance: report\.inicial/.test(rest)) {
        return falla('la API dejó de publicar el saldo inicial y sus descuadres: se calculan y se tiran, que es como estaban antes de F07a');
      }
      // 3. Y LA CASILLA QUE FALTABA. Sin agrupador no hay catálogo que
      //    entregar; el COMMENT de la 037 llevaba prometiéndola desde
      //    entonces sobre una columna que nadie escribía.
      const casilla = /'sat-agrupador-missing'/.test(cierre);
      return casilla
        ? ok('el agrupador tiene una sola columna, la balanza publica saldo inicial y descuadres, y el cierre avisa de las cuentas con movimiento sin agrupar')
        : falla('desapareció la casilla del agrupador: se podría cerrar un mes cuyas cuentas movidas no se pueden entregar al SAT');
    },
  },

  // ---- D1a · El devengo existe, y lo que ya se pagaba se paga bien ----

  {
    paquete: 'E1.2',
    id: 'prepaid-schedule-backed-by-ledger',
    enunciado: 'La amortización vale lo que el mayor respalda, y las prestaciones se calculan como manda la ley',
    mutantes: [
      {
        // El defecto de gravedad 1 que el adversarial cazó: reversar el
        // asiento de una amortización devolvía el importe a la 1160, pero el
        // renglón seguía contando como posteado. Cuatro instrumentos mentían
        // a la vez y el gasto no volvía NUNCA, porque el freno de doble
        // corrida lo daba por hecho.
        archivo: 'src/services/accruals/prepaid-service.ts',
        de: 'export const RENGLON_VIGENTE = `s.is_posted = true AND EXISTS (',
        a: 'export const RENGLON_VIGENTE = `s.is_posted = true AND NOT EXISTS (',
        porque: 'un renglón dejaría de exigir respaldo en el mayor: la ficha afirmaría gasto devengado que una reversa ya deshizo, y el saldo revertido se ofrecería otra vez como libre',
      },
      {
        // La tabla del art. 76 tras la reforma de 2023 sube DOS DÍAS CADA
        // QUINQUENIO a partir del sexto año, no cada año. Contarlo por año
        // pagaba de menos en cuatro de cada cinco ejercicios.
        archivo: 'src/services/payroll/mx/finiquito-math.ts',
        de: '  const quinquenios = Math.ceil((anio - 5) / 5);',
        a: '  const quinquenios = Math.floor((anio - 5) / 5);',
        porque: 'devuelve la tabla del art. 76 al defecto que D1a reparó: paga dos días de vacaciones DE MENOS en cuatro de cada cinco años de antigüedad a partir del sexto, en el finiquito de una persona',
      },
    ],
    evaluar: () => {
      const svc = codigoDe('src/services/accruals/prepaid-service.ts');
      const mate = codigoDe('src/services/payroll/mx/finiquito-math.ts');

      // 1. UN RENGLÓN VALE MIENTRAS EL MAYOR LO RESPALDE. El mayor es
      //    inmutable (041) y sólo se corrige por reversa, así que la reversa
      //    es un camino NORMAL, no una excepción: cualquier caché que no la
      //    mire acaba afirmando un gasto que ya se deshizo.
      if (!/RENGLON_VIGENTE/.test(svc) || !/is_posted = true AND EXISTS \(/.test(svc)) {
        return falla('la amortización volvió a fiarse de is_posted sin mirar el mayor: una reversa dejaría la ficha, el respaldo disponible y la casilla del cierre afirmando un gasto que ya no existe');
      }
      // 2. Y EL RESPALDO SE MIDE Y SE CONSUME EN LA MISMA TRANSACCIÓN. Sin el
      //    cerrojo, dos altas simultáneas sobre el mismo cargo pasaban las
      //    dos: 48 000 amortizables sobre 24 000 pagados, la 1160 en negativo
      //    —un activo con saldo acreedor— y el balance cuadrando.
      if (!/FOR UPDATE/.test(svc)) {
        return falla('desapareció el cerrojo del respaldo: dos altas concurrentes sobre el mismo cargo volverían a pasar las dos y la 1160 quedaría en negativo');
      }
      // 3. LA LEY, COMO ESTÁ ESCRITA. El art. 76 reformado sube dos días por
      //    QUINQUENIO desde el sexto año; el aguinaldo se prorratea por días
      //    trabajados (art. 87); y la base es el salario diario, no el
      //    integrado, que ya lleva dentro el factor de estas prestaciones.
      const quinquenios = /Math\.ceil\(\(anio - 5\) \/ 5\)/.test(mate);
      return quinquenios
        ? ok('la amortización se apoya en el mayor y se serializa, y la tabla del art. 76 sube por quinquenio como la ley dice')
        : falla('la tabla del art. 76 volvió a contar por año en vez de por quinquenio: paga de menos a partir del sexto año de antigüedad');
    },
  },

  // ---- G0 · La tarde que se paga sola ----

  {
    paquete: 'E1.2',
    id: 'close-lock-without-row-rewrite',
    enunciado: 'El candado del cierre bloquea sin reescribir la tabla, y el perímetro no confía en una cabecera que escribe quien llama',
    mutantes: [
      {
        // Volver al UPDATE. El diente exacto: la sentencia que asignaba a cada
        // fila el valor que ya tenía.
        archivo: 'src/services/accounting/period-close.ts',
        de: '      `SELECT id FROM journal_entries\n       WHERE fiscal_period_id = $1 AND entity_id = $2\n       FOR UPDATE`,',
        a: "      `UPDATE journal_entries SET status = CASE WHEN status = 'posted' THEN 'posted' ELSE status END\n       WHERE fiscal_period_id = $1 AND entity_id = $2`,",
        porque: 'el candado vuelve a reescribir cada fila para no cambiar nada: Postgres versiona, rehace los índices y dispara el guardián de inmutabilidad una vez POR FILA, y con 800 000 asientos el cierre de mes muere contra su propio statement_timeout',
      },
      {
        archivo: 'src/api/rest/trust-proxy.ts',
        de: "export function resolverTrustProxy(",
        a: "export function resolverTrustProxy_desactivado(",
        porque: 'el perímetro se queda sin resolutor de proxy: o se confía en todo —y entonces req.ip lo escribe quien llama y el freno deja de existir— o se confía en nada y todos los inquilinos comparten un cubo',
      },
    ],
    evaluar: () => {
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const tp = codigoDe('src/api/rest/trust-proxy.ts');
      const cx = codigoDe('src/database/connection.ts');

      // 1. EL CANDADO PIDE EL CANDADO, no lo consigue de rebote. El cierre
      //    duro bloqueaba los asientos del periodo con un UPDATE que asignaba
      //    a cada fila el valor que ya tenía: cero filas cambiadas de
      //    1 500 000, y aun así Postgres versiona cada una, rehace sus doce
      //    índices —`status` está indexado tres veces, así que no hay
      //    actualización HOT que lo salve— y dispara el guardián de
      //    inmutabilidad por fila. Medido: 87 s contra un tope de 60. El
      //    tramo que puso el tope encontró lo que el tope mataba.
      //    Se ancla la consulta ENTERA y no las dos palabras `FOR UPDATE`:
      //    el archivo tiene otros candados legítimos, y un ancla que casa con
      //    cualquiera de ellos sobrevive al mutante que devuelve el UPDATE.
      if (!/SELECT id FROM journal_entries\s+WHERE fiscal_period_id = \$1 AND entity_id = \$2\s+FOR UPDATE/.test(pc)) {
        return falla('el candado del cierre dejó de pedirse directo: si vuelve a lograrse con un UPDATE que no escribe nada, el cierre de un ejercicio grande muere contra su propio tope de sentencia');
      }
      // 2. EL PERÍMETRO NO CONFÍA A CIEGAS. `trust proxy` en true hace que
      //    req.ip sea la entrada más a la izquierda de X-Forwarded-For, que
      //    la escribe quien llama: cada petición estrena cubo y el freno de
      //    /public/v1 deja de existir. El defecto es `false` porque es el
      //    único valor NO ELUDIBLE: su coste —un cubo compartido— es ruidoso
      //    y se nota; un limitador que no limita, no.
      //    Con el paréntesis: sin él, el ancla casa igual con un
      //    `resolverTrustProxy_desactivado` y el mutante que lo renombra
      //    sobrevive. Es la lección que el arnés cobró en F06a.
      if (!/export function resolverTrustProxy\(/.test(tp)) {
        return falla('desapareció el resolutor de trust proxy: el perímetro vuelve a confiar en la cabecera o a meter a todos los inquilinos en un cubo');
      }
      // 3. Y EL POOL TIENE LOS TRES TOPES. Sin ellos la petición 21 del día de
      //    cierre espera para siempre.
      const topes = ['statement_timeout', 'lock_timeout', 'connectionTimeoutMillis'].filter((t) => cx.includes(t));
      return topes.length === 3
        ? ok('el candado del cierre se pide directo, el perímetro declara en quién confía, y el pool tiene sus tres topes')
        : falla(`al pool le faltan topes (${3 - topes.length} de 3): la petición 21 del día de cierre vuelve a esperar para siempre`);
    },
  },

  // ---- G1b · El flujo de efectivo, amarrado al efectivo ----

  {
    paquete: 'E1.2',
    id: 'cash-flow-classified-by-role',
    enunciado: 'El estado de flujos clasifica por ROL, no por el nombre en inglés de la cuenta, y se amarra contra el efectivo real',
    mutantes: [
      {
        // El diente exacto del tramo: volver a preguntar por el NOMBRE. El
        // motor viejo hacía `name ILIKE '%receivable%'` contra un catálogo
        // que este mismo producto siembra en español, así que no casaba nada
        // y el capital de trabajo salía en cero — sin que ninguna prueba lo
        // notara, porque cero es un número perfectamente presentable.
        archivo: 'src/services/reporting/cash-flow-service.ts',
        de: '               FROM account_roles ar',
        a: '               FROM accounts ar_por_nombre',
        porque: 'la clasificación vuelve a colgar del NOMBRE de la cuenta en vez del rol, que es el defecto histórico exacto: contra un catálogo sembrado en español no casa nada y el capital de trabajo sale en cero, que es un número perfectamente presentable',
      },
    ],
    evaluar: () => {
      const cf = codigoDe('src/services/reporting/cash-flow-service.ts');
      const rc = codigoDe('src/services/reporting/cash-flow-reconcile.ts');

      // 1. EL MOTOR SALIÓ DE LA RUTA. Era el ÚNICO informe que nunca se
      //    extrajo a la capa de servicios: vivía dentro de src/api/rest, así
      //    que el CLI y el agente no lo tenían y REST era un segundo motor.
      if (!/export async function politicasDeFlujo/.test(cf)) {
        return falla('el estado de flujos volvió a vivir sólo en la ruta REST: el CLI y el agente se quedan sin él, y REST vuelve a ser un motor aparte');
      }
      // 2. SE CLASIFICA POR ROL, NO POR NOMBRE. El mapa de roles sobrevive a
      //    renombres, traducciones y catálogos importados; los nombres no.
      if (!/FROM account_roles ar/.test(cf)) {
        return falla('la clasificación del flujo dejó de pasar por el mapa de roles: si vuelve a preguntar por el nombre, el capital de trabajo saldrá en cero contra cualquier catálogo en español');
      }
      // 3. Y EL RESIDUO SE IMPRIME, NO SE ABSORBE. Es el único estado
      //    financiero cuyo error se comprueba desde fuera: cualquiera lo
      //    contrasta contra su banco. Meterlo dentro de un renglón esconde
      //    justo lo que el lector habría cazado.
      const amarre = /export async function conciliarFlujoDeEfectivo/.test(rc);
      return amarre
        ? ok('el flujo vive en la capa compartida, clasifica por rol y se contrasta contra el efectivo real con el residuo a la vista')
        : falla('desapareció el amarre contra el efectivo real: el estado de flujos vuelve a poder no tener ninguna relación con el banco sin que nadie lo diga');
    },
  },

  // ---- T13 · El instrumento que afirma más de lo que mide ----

  {
    paquete: 'E1.2',
    id: 'cashflow-selfcheck-lists-and-policy-blocks',
    enunciado:
      'La autocomprobación del flujo mide la LISTA de cuentas sin sección y no su suma, la política «bloquear» bloquea de verdad, y los roles de efectivo crecen en un solo sitio',
    mutantes: [
      {
        // EL DIENTE EXACTO DEL TRAMO: devolver el guardia a preguntar por la
        // SUMA. Es la línea tal como estaba escrita antes de T13.
        archivo: 'src/services/reporting/cash-flow-service.ts',
        de: "  if (!autoComprobacion.all_classified && policies.sinClasificar === 'bloquear') {",
        a: "  if (!autoComprobacion.ties && policies.sinClasificar === 'bloquear') {",
        porque:
          'la política que el despacho puso en «bloquear» vuelve a no bloquear: dos cuentas sin ' +
          'fs_category de +5 000 y −5 000 dejan la suma en cero y el estado sale FIRMADO bajo la ' +
          'política que había pedido no emitirlo. Una política que no hace lo que dice es peor que ' +
          'no tenerla, porque quien la eligió cree que hay un guardia',
      },
      {
        // El otro diente, una capa más abajo: que la afirmación vuelva a
        // derivarse de la suma. Sobrevive a cualquier criterio que sólo mire
        // si el campo EXISTE.
        archivo: 'src/services/reporting/cash-flow-service.ts',
        de: '    all_classified: todasClasificadas,',
        a: '    all_classified: netoAta,',
        porque:
          'la autocomprobación vuelve a medir la SUMA en vez de la LISTA, que es el defecto entero: ' +
          'la nota firma «every account that moved was classified» sobre cuentas que nadie clasificó, ' +
          'y los subtotales de operación, inversión y financiamiento quedan mal cada uno por su parte',
      },
      {
        archivo: 'src/services/reporting/cash-flow-service.ts',
        de: '              WHERE ar.entity_id = $1 AND ar.role = ANY($2::text[])',
        a: "              WHERE ar.entity_id = $1 AND ar.role = 'banco'",
        porque:
          'el ESTADO vuelve a codificar un rol a mano mientras el AMARRE lee ROLES_DE_EFECTIVO, que ' +
          'se declara punto único de crecimiento: hoy coinciden por casualidad —la lista tiene un ' +
          'elemento— y el día que crezca los dos publican conjuntos de efectivo distintos del mismo ' +
          'periodo, con un residuo inventado que nadie podrá encontrar',
      },
    ],
    evaluar: async () => {
      const cf = codigoDe('src/services/reporting/cash-flow-service.ts');
      const rc = codigoDe('src/services/reporting/cash-flow-reconcile.ts');

      // ── LA MITAD QUE MIDE ────────────────────────────────────
      //
      // `autoComprobar` es PURA, así que el escenario que costó este tramo
      // cabe aquí sin base de datos: dos cuentas sin `fs_category` cuyos
      // importes se cancelan. Se corre el camino real y se juzga lo que
      // AFIRMA, no cómo está escrito — un criterio que sólo leyera la línea
      // sobreviviría a que la aritmética volviera a mentir por otra puerta.
      const { autoComprobar, construirIndirecto } = await import(
        '../../services/reporting/cash-flow-service.js'
      );
      const cuenta = (
        code: string,
        name: string,
        account_type: string,
        fs_category: string | null,
        debit_total: string,
        credit_total: string
      ) => ({
        account_id: `plan-${code}`,
        code,
        name,
        account_type,
        account_subtype: null,
        fs_category,
        debit_total,
        credit_total,
      });
      // Una venta cobrada (clasificable) y DOS cuentas importadas sin
      // categoría, de +5 000 y −5 000: la suma da cero y la lista tiene dos.
      const compensadas = autoComprobar(
        construirIndirecto([
          cuenta('4100', 'Ventas', 'revenue', 'revenue', '0', '9000'),
          cuenta('1295', 'Equipo importado', 'asset', null, '5000', '0'),
          cuenta('2295', 'Crédito importado', 'liability', null, '0', '5000'),
        ])
      );
      if (compensadas.all_classified) {
        return falla(
          'la autocomprobación del flujo vuelve a decir que clasificó todo con DOS cuentas sin ' +
            'sección en la mano: le basta que sus importes se cancelen, que es exactamente cómo un ' +
            'estado con las tres secciones mal se firma sin que nadie avise'
        );
      }
      // Y NO SE EXAGERA EL DAÑO: el neto sí ata. Inventar un descuadre que el
      // banco desmiente en dos minutos es el error simétrico, y quema el
      // instrumento igual de rápido.
      if (!compensadas.ties) {
        return falla(
          'la autocomprobación declara descuadrado un estado cuyo neto SÍ iguala la variación del ' +
            'efectivo: un aviso que el banco desmiente deja de leerse, y con él los que sí importan'
        );
      }
      if (/Every account that moved was classified/.test(compensadas.note)) {
        return falla(
          'la nota del flujo vuelve a afirmar que toda cuenta que se movió cayó en una sección ' +
            'mientras dos no lo hicieron: es la frase que el instrumento firmaba sin haberla medido'
        );
      }
      if (!compensadas.note.includes('1295') || !compensadas.note.includes('2295')) {
        return falla(
          'la nota avisa del hueco sin nombrar las cuentas que lo abren: un aviso sin códigos no es ' +
            'una pista, y el lector no tiene por dónde empezar'
        );
      }
      // El caso limpio sigue diciendo lo suyo: un instrumento que grita
      // siempre no dice nada.
      const limpio = autoComprobar(
        construirIndirecto([cuenta('4100', 'Ventas', 'revenue', 'revenue', '0', '9000')])
      );
      if (!limpio.all_classified || !limpio.ties) {
        return falla(
          'la autocomprobación denuncia un estado en el que TODA cuenta cayó en su sección: un ' +
            'instrumento que grita siempre no distingue nada'
        );
      }

      // ── LA MITAD QUE ANCLA ───────────────────────────────────
      //
      // Las tres líneas que los espejos tocan. La medición de arriba corre
      // sobre el módulo REAL —`await import` no pasa por el seam de lectura—,
      // así que sin estas anclas los tres mutantes seguirían vivos: es la
      // lección que este repositorio ya cobró tres veces, y por eso el
      // criterio hace las dos cosas y no una.
      // La política que gobierna esto es la SUYA, no la del descuadre: el
      // desacuerdo con el efectivo y la cuenta sin sección son dos preguntas
      // distintas, y la ficha del descuadre —«refuse until it ties»— quedaría
      // insatisfacible por sus propios términos si rehusara un estado que ATA.
      if (!/if \(!autoComprobacion\.all_classified && policies\.sinClasificar === 'bloquear'\)/.test(cf)) {
        return falla(
          'el guardia de «bloquear» dejó de preguntar por las cuentas sin sección: si vuelve a ' +
            'mirar la suma, la política que pidió no emitir el estado lo emite'
        );
      }
      if (!/all_classified: todasClasificadas,/.test(cf)) {
        return falla(
          'la afirmación «todo clasificado» volvió a derivarse de otra cosa que la lista de cuentas ' +
            'sin sección: es la sustitución exacta que hacía mentir a la nota'
        );
      }
      // 3. EL ROL NO SE ESCRIBE A MANO. Se comprueba sobre CADA rol de la
      //    lista y no sobre la palabra «banco»: un ancla escrita contra un rol
      //    concreto es la misma trampa una capa más arriba, y bendice al que
      //    codifique el siguiente.
      const { ROLES_DE_EFECTIVO } = await import('../../services/reporting/cash-flow-reconcile.js');
      const aMano = ROLES_DE_EFECTIVO.filter((rol) => cf.includes(`ar.role = '${rol}'`));
      if (aMano.length > 0) {
        return falla(
          `el estado de flujos vuelve a codificar el rol de efectivo a mano (${aMano.join(', ')}) ` +
            'mientras el amarre lee ROLES_DE_EFECTIVO: el día que la lista crezca, los dos ' +
            'publicarán conjuntos de efectivo distintos del mismo periodo'
        );
      }
      if (!/ar\.role = ANY\(\$2::text\[\]\)/.test(cf) || !/\[entityId, ROLES_DE_EFECTIVO\]/.test(cf)) {
        return falla(
          'el estado de flujos dejó de resolver el efectivo por LA LISTA de roles: el punto único de ' +
            'crecimiento que cash-flow-reconcile declara vuelve a tener un segundo sitio'
        );
      }
      // Y la lista sigue siendo de quien dice serlo: si el punto único se
      // mudara, este criterio estaría anclando en un archivo que ya no manda.
      if (!/export const ROLES_DE_EFECTIVO/.test(rc)) {
        return falla(
          'ROLES_DE_EFECTIVO dejó de vivir en cash-flow-reconcile, que es donde se declara punto ' +
            'único de crecimiento: el estado lo importa de ahí y el ancla apunta a un archivo mudo'
        );
      }
      return ok(
        'con dos cuentas sin sección que se compensan la autocomprobación dice all_classified=false ' +
          'y ties=true, la nota las nombra sin afirmar lo que no midió, «bloquear» pregunta por esa ' +
          'lista y no por su suma, y el conjunto de efectivo sale de ROLES_DE_EFECTIVO y de ningún ' +
          'rol escrito a mano'
      );
    },
  },

  // ---- G1a · Los estados que ya se firman, y que hoy mentían ----

  {
    paquete: 'E1.2',
    id: 'close-sweeps-by-balance-sign',
    enunciado: 'El cierre barre por el SIGNO del saldo, comprueba que barrió, y los informes no cuentan el cierre como actividad',
    mutantes: [
      {
        // El signo del saldo, no la forma de la consulta. El banco unitario
        // FABRICA ending_balance recomponiendo la resta que la consulta
        // declara (report-service.spec.ts:62), así que invertirla pasaba las
        // 3 500 pruebas en verde y sólo la acusaba un regex sobre el TEXTO
        // del SQL. La prueba de conducta de G1a es la que ahora la mata.
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS ending_balance',
        a: 'COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) AS ending_balance',
        porque: 'invierte el signo de TODO saldo publicado: la balanza, el estado de resultados y el balance general dirían lo contrario de lo que los libros dicen, y hasta G1a ninguna prueba de cifras lo notaba',
      },
      {
        // La línea que el reconocimiento de S4 demostró desprotegida: invirtió
        // ÉSTA —la del balance general, no la anclada— y el arnés, el plan y
        // las 3 435 unitarias siguieron en verde. Una utilidad de 3 000
        // publicada como pérdida de 2 000, otra vez, por la puerta de al lado.
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as balance',
        a: 'COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) as balance',
        porque: 'invierte el signo en la consulta del BALANCE GENERAL: el capital contable se publica del revés y ninguna prueba de la vía rápida lo nota',
      },
      {
        // El diente, no la boca: el saldo se consulta DOS veces (ingresos y
        // gastos) y mutar una sola basta, porque el barrido de esa mitad cae
        // del lado contrario y el ejercicio queda sin barrer.
        archivo: 'src/services/accounting/period-close.ts',
        de: 'SUM(ab.debit_total - ab.credit_total) as balance',
        a: 'SUM(ab.credit_total - ab.debit_total) as balance',
        porque: 'el cierre barrería los ingresos por el lado equivocado: las cuentas quedan al doble en vez de en cero y el resultado entra invertido al capital, que es el defecto exacto que este tramo vino a matar',
      },
    ],
    evaluar: () => {
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const cc = codigoDe('src/services/reporting/criterio-cierre.ts');
      const lc = codigoDe('src/services/accounting/ledger-checks.ts');
      const rs = codigoDe('src/services/reporting/report-service.ts');

      // 0. EL ORDEN DE LA RESTA ES LA AFIRMACIÓN, y por eso se ancla literal:
      //    un saldo es cargos MENOS abonos, en ese orden, y al revés todo lo
      //    publicado dice lo contrario de lo que los libros dicen. Se ancla
      //    aquí —y no sólo en la prueba de conducta— porque un criterio sólo
      //    mata lo que inspecciona: la primera versión de este bloque no
      //    leía report-service, y sus dos mutantes sobrevivieron.
      // SE CUENTAN LAS CINCO. La primera versión ancló sólo la de
      // `AS ending_balance` y dejó fuera las otras cuatro —entre ellas la del
      // BALANCE GENERAL (:445)—, así que invertir el signo una línea más abajo
      // pasaba el arnés, el plan y las 3 435 unitarias: sólo lo acusaba un job
      // de integración de cuatro minutos que nadie corre antes de empujar. Es
      // la lección que este mismo criterio aplica a period-close doce líneas
      // más abajo, y que no se aplicó al archivo que acababa de añadir.
      const saldosPublicados = (
        rs.match(/COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\) - COALESCE\(jel\.credit_amount, 0\)\)/g) ?? []
      ).length;
      if (saldosPublicados !== 5) {
        return falla(
          `${5 - saldosPublicados} de las cinco consultas del saldo publicado tienen la resta invertida: ` +
            'la balanza, el estado de resultados o el balance general dirían lo contrario de lo que dicen los libros'
        );
      }
      // Se CUENTAN las dos apariciones —ingresos y gastos— en vez de
      //    comprobar que haya una: son gemelas textuales, y un mutante que
      //    invierta sólo la primera deja la segunda en pie, así que la
      //    presencia seguiría siendo cierta mientras el cierre barre medio
      //    ejercicio del revés. Es la trampa que ya cobró piezas en F04.
      const consultasDelSaldo = (pc.match(/SUM\(ab\.debit_total - ab\.credit_total\) as balance/g) ?? []).length;
      if (consultasDelSaldo !== 2) {
        return falla(
          `el cierre consulta el saldo con la resta invertida en ${2 - consultasDelSaldo} de sus dos mitades: ` +
            'barrería por el lado equivocado y el resultado entraría invertido al capital'
        );
      }

      // 1. EL LADO LO DECIDE EL SIGNO. Durante un año el emisor usó abs(),
      //    que acierta por casualidad en la cuenta de naturaleza normal y
      //    DUPLICA la contra-natural: la 4400 (revenue deudora) recibía otro
      //    cargo y la 5200 (expense acreedora) otro abono. Con ventas 10 000,
      //    devolución 2 000, costo 6 000 y devolución de compras 1 000, una
      //    utilidad de 3 000 se publicaba como PÉRDIDA de 2 000 — y el
      //    balance decía is_balanced true, porque el renglón del resultado
      //    cancelaba exactamente el exceso.
      if (!/function lineaQueBarre/.test(pc) || !/balance\.greaterThan\(0\)/.test(pc)) {
        return falla('el barrido del cierre dejó de decidir el lado por el signo: las cuentas contra-naturales volverían a duplicarse en vez de barrerse');
      }
      // 2. Y SE COMPRUEBA QUE BARRIÓ. Nada lo comprobaba, que es por lo que
      //    el defecto anterior vivió tanto: el asiento cuadraba.
      if (!/verificarQueElEjercicioBarrio/.test(pc)) {
        return falla('nadie comprueba que el ejercicio cerrado quede en cero: un cierre que no barre volvería a pasar inadvertido');
      }
      // 3. EL INFORME NO CUENTA EL CIERRE COMO ACTIVIDAD. El asiento se fecha
      //    al final del periodo que cierra —dentro del rango que el propio
      //    informe consulta—, así que un ejercicio cerrado imprimía «Net
      //    income 0.0000» en las TRES superficies, que comparten la consulta.
      if (!/export function predicadoSinCierre/.test(cc)) {
        return falla('desapareció el criterio compartido del cierre: el estado de resultados de un ejercicio cerrado volvería a salir en ceros');
      }
      // 4. LOS SALDOS MATERIALIZADOS SE VERIFICAN CONTRA SU PROPIO
      //    INVARIANTE. checkBalance sólo miraba debit_total/credit_total:
      //    inyectar 99 999 en ending_balance —la columna que el cierre
      //    escribe y el ejercicio siguiente HEREDA— devolvía cero hallazgos.
      const invariante = /ab\.beginning_balance \+ ab\.debit_total - ab\.credit_total/.test(lc);
      return invariante
        ? ok('el cierre barre por el signo y se comprueba, los informes no cuentan el cierre como actividad, y ending_balance ya no es una columna que nadie verifica')
        : falla('ending_balance volvió a ser invisible para el chequeo del mayor: inyectarle una cifra falsa no daría hallazgo');
    },
  },

  // ---- R4 · La moneda extranjera, convertida en el origen ----

  {
    paquete: 'E1.2',
    id: 'foreign-currency-origin-preserved',
    enunciado: 'El asiento en moneda extranjera nace con su origen, la conversión se verifica y la reversa lo conserva cruzado',
    mutantes: [
      {
        // El diente: la reversa de un asiento USD construía el espejo sólo en
        // funcional — la pérdida de origen que R4 existe para matar,
        // reintroducida por la puerta de la reversión (afecta reverse, void y
        // batch reverse). El adversarial la cazó con prueba que fallaba.
        archivo: 'src/services/accounting/posting.ts',
        de: '    foreign_debit: line.foreign_credit ?? undefined,',
        a: '    foreign_debit: undefined,',
        porque: 'el espejo pierde el lado extranjero: reversar un asiento en dólares vuelve a parir un asiento sólo-funcional, y el importe original muere en silencio por la puerta de atrás',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerFxCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerFxCommand fuera del binario',
        porque: 'quinta repetición del defecto de la casa: fx-command.ts pasa su spec sobre un Command propio mientras el binario no lo carga — el segundo verificador de R4 lo encontró exactamente así',
      },
    ],
    evaluar: () => {
      const post = codigoDe('src/services/accounting/posting.ts');

      // 1. Las cuatro columnas FX de la 001 POR FIN se escriben. Antes el
      //    INSERT escribía nueve columnas y todo asiento en dólares perdía su
      //    origen al nacer — currencyRule no podía dispararse jamás.
      if (!/currency_code, foreign_debit, foreign_credit, exchange_rate/.test(post)) {
        return falla('el INSERT de createJournalEntry dejó de escribir las columnas FX: el asiento en moneda extranjera vuelve a nacer sin origen');
      }
      // 2. La conversión se VERIFICA, no se confía: cada línea pasa por
      //    verificarOrigenFx (funcional = extranjero × tasa, half-up a 4) y el
      //    rechazo trae los tres números. Sin esto, un llamador puede declarar
      //    un origen que no casa y el mayor archiva la mentira con CHECK verde.
      if (!/verificarOrigenFx\(line, monedaFuncional, i \+ 1\)/.test(post)) {
        return falla('createJournalEntry dejó de verificar el origen contra la conversión: una línea podría declarar un extranjero que no casa con su funcional');
      }
      // 3. La reversa CRUZA los lados extranjeros igual que los funcionales.
      if (!/foreign_debit: line\.foreign_credit \?\? undefined,/.test(post)) {
        return falla('la reversa dejó de cruzar el origen: el espejo de un asiento en dólares nacería sólo-funcional');
      }
      // 4. La fluctuación se identifica (B-15): utilidad y pérdida cambiaria
      //    tienen cuenta PROPIA — compartir la 4300/6300 con otros ingresos y
      //    gastos financieros las hacía invisibles, y el neteo es del reporte,
      //    no de las cuentas.
      const seed = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      if (!/utilidad_cambiaria: '4320'/.test(seed) || !/perdida_cambiaria: '6320'/.test(seed)) {
        return falla('los roles cambiarios volvieron a compartir cuenta: la fluctuación deja de poder identificarse (NIF B-15)');
      }
      const entregada = /registerFxCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      return entregada
        ? ok('las cuatro columnas se escriben, la conversión se verifica con los tres números, la reversa cruza el origen, la fluctuación tiene cuenta propia y la familia está en el binario')
        : falla('registerFxCommand no está en el binario: R4 quedó verificada y no entregada');
    },
  },

  // ---- F06a · El activo y su corrida ----

  {
    paquete: 'E1.2',
    id: 'depreciation-month-posted-once',
    enunciado: 'El mismo mes no se carga dos veces al mayor, ni cambiando la política entre corridas',
    mutantes: [
      {
        archivo: 'src/services/assets/depreciation.ts',
        de: "            AND (ds.is_posted = true OR ds.schedule_type = $3)",
        a: "            AND ds.schedule_type = $3",
        porque: 'el freno vuelve a acotarse por libro: correr marzo, contestar el panel con la otra base y correr marzo otra vez postea un SEGUNDO asiento — 20.000 en el mayor para un mes que vale 10.000, y con la 041 eso son reversas, no ediciones',
      },
    ],
    evaluar: () => {
      // MEDIDO por el verificador adversarial, y la secuencia es la que el
      // propio sistema invita a hacer: correr el mes con `vida_util_nif`,
      // contestar el panel con `tasa_lisr` —literalmente lo que sugiere el
      // mensaje de criteriosDeLaCorrida— y correr otra vez. El freno estaba
      // acotado por `schedule_type`, así que la segunda corrida no encontraba
      // fila `tax` y debitaba la misma cuenta de gasto por segunda vez.
      //
      // Por eso el freno tiene dos mitades: un renglón `is_posted` de
      // CUALQUIER libro cierra el mayor para ese mes, y el tipo sigue cerrando
      // la UNIQUE para el calendario.
      const svc = codigoDe('src/services/assets/depreciation.ts');
      if (!/AND \(ds\.is_posted = true OR ds\.schedule_type = \$\d\)/.test(svc)) {
        return falla('el freno de la corrida volvió a acotarse por libro: cambiar la política entre corridas cargaría el mismo mes dos veces');
      }
      // Y LA FICHA SE DERIVA DE LO POSTEADO, no del calendario teórico. Los
      // meses no tienen por qué correrse en orden: con el acumulado teórico,
      // correr marzo→enero→febrero dejaba la ficha un mes por debajo PARA
      // SIEMPRE y last_depreciation_date retrocedía. Derivada de la suma de
      // renglones posteados —que la 056 garantiza con asiento detrás—, ficha
      // y mayor coinciden por construcción en cualquier orden.
      const derivada = /current_book_value = fa\.acquisition_cost - p\.acumulada,/.test(svc) &&
        /SELECT COALESCE\(SUM\(ds\.depreciation_expense\), 0\) AS acumulada,/.test(svc);
      return derivada
        ? ok('el freno mira lo posteado de cualquier libro y la ficha es la suma de lo posteado: mayor y ficha no pueden separarse')
        : falla('la ficha volvió a copiar el renglón teórico del calendario: correr los meses en desorden la separa del mayor para siempre');
    },
  },

  {
    paquete: 'E1.2',
    id: 'depreciation-final-row-absorbs-rounding',
    enunciado: 'La vida del activo suma exacta: doce filas en doce meses y el tapón cierra al peso',
    mutantes: [
      {
        archivo: 'src/services/assets/depreciation-math.ts',
        de: '    const restante = base.minus(acumulado);',
        a: '    const restante = base.dividedBy(2);',
        porque: 'el último renglón deja de absorber la diferencia de redondeo: 100.000 a 36 meses vuelve a acumular 100.000,0008 y el activo nunca llega a cero exacto',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerAssetCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerAssetCommand fuera del binario',
        porque: 'el alta se queda verificada y no entregada: sin ficha no hay activo, y sin activo toda la aritmética de este criterio es letra muerta',
      },
    ],
    evaluar: () => {
      // El defecto original: el índice del calendario dividía milisegundos
      // entre 30,44 días —la longitud MEDIA de un mes—, así que marzo repetía
      // la fila de febrero y la última no se consumía nunca: once filas en
      // doce meses, y la suma posteada jamás daba costo menos salvamento.
      // E1.4 ancla el índice; aquí se ancla LO OTRO que hace exacta la vida.
      const math = codigoDe('src/services/assets/depreciation-math.ts');
      // El tapón: el último renglón es base − acumulado, no una división más.
      // Aparece en dos series (línea recta y decrecientes); se CUENTAN porque
      // son gemelos y un ancla de presencia se conforma con encontrar el otro.
      const tapones = (math.match(/const restante = base\.minus\(acumulado\);/g) ?? []).length;
      if (tapones < 2) {
        return falla(
          `el tapón del último renglón sobrevive en ${tapones} de las 2 series que agotan la base: la que lo pierda dejará residuo de redondeo para siempre`
        );
      }
      // Y el dinero entra como STRING: el motor viejo pasaba DECIMAL(19,4) por
      // parseFloat, que es por donde se cuelan los centavos.
      if (!/acquisition_cost: string;[\s\S]{0,80}?salvage_value: string;/.test(math)) {
        return falla('el costo o el salvamento volvieron a ser number: los centavos se pierden en el parseFloat de entrada');
      }
      // Y EL ALTA ESTÁ EN EL BINARIO. Sin ficha no hay activo, y sin activo
      // toda la aritmética de arriba es letra muerta — el «verde no es
      // entregado» que F05a enseñó y F06a repitió con la otra familia.
      const entregada = /registerAssetCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      return entregada
        ? ok('el tapón cierra las dos series al peso, el dinero viaja como cadena y el alta está en el binario')
        : falla('registerAssetCommand no está en el binario: el alta quedó verificada y no entregada, y nadie puede crear la ficha');
    },
  },

  // ---- F05a · La cuenta y el extracto ----

  {
    paquete: 'E1.2',
    id: 'bank-statement-document-with-balances',
    enunciado: 'El extracto es un documento con sus dos saldos, y el mismo archivo no entra dos veces',
    mutantes: [
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '    UNIQUE (bank_account_id, file_sha256)',
        a: '    CHECK (line_count >= 0)',
        porque: 'el mismo archivo del banco vuelve a poder importarse entero: el extracto se duplica y el saldo de banco deja de ser el del banco',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '    opening_balance DECIMAL(19,4) NOT NULL,',
        a: '    opening_balance DECIMAL(19,4),',
        porque: 'el saldo inicial vuelve a poder faltar, que es exactamente por lo que la sesión de conciliación llevaba un cero fijo en su lugar',
      },
    ],
    evaluar: () => {
      // Hasta F05a el módulo bancario tenía movimientos sueltos colgando de un
      // `import_batch_id` que era un UUID sin tabla, y una sesión que insertaba
      // su `beginning_balance` FIJO EN CERO porque no tenía de dónde sacarlo.
      // Las siete pruebas de integridad son preguntas sobre un DOCUMENTO con
      // saldo inicial y final; sin él no hay ninguna que se pueda formular.
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');

      if (!/CREATE TABLE bank_statements/.test(sql)) {
        return falla('no existe la tabla del estado de cuenta: sin documento no hay conciliación posible');
      }
      // Los dos saldos, OBLIGATORIOS. Un saldo que puede faltar reproduce el
      // cero-que-significa-nada del que venimos.
      const obligatorias = ['opening_balance', 'closing_balance'].filter(
        (c) => !new RegExp(`${c} DECIMAL\\(19,4\\) NOT NULL`).test(sql)
      );
      if (obligatorias.length > 0) {
        return falla(`el estado de cuenta admite saldo ausente en: ${obligatorias.join(', ')}`);
      }
      // El hash del archivo ORIGINAL: el extracto es evidencia fiscal y quien
      // lo audite tiene que poder atar el PDF del banco con lo que entró.
      if (!/file_sha256 CHAR\(64\) NOT NULL/.test(sql)) {
        return falla('el estado de cuenta no guarda el hash de su archivo: deja de ser evidencia atable');
      }
      const dedupe = /UNIQUE \(bank_account_id, file_sha256\)/.test(sql);
      return dedupe
        ? ok('el estado de cuenta lleva sus dos saldos obligatorios y el hash de su archivo, y el mismo archivo no entra dos veces')
        : falla('desapareció el dedupe por archivo: reimportar el mismo extracto volvería a duplicarlo entero');
    },
  },

  {
    paquete: 'E1.2',
    id: 'bank-statement-integrity-suite',
    enunciado: 'Las siete pruebas del extracto existen todas y su hallazgo bloqueante sale 4',
    mutantes: [
      {
        archivo: 'src/services/banking/statement-checks.ts',
        de: "      check: 'continuidad',",
        a: "      check: 'cadena-de-saldos',",
        porque: 'la prueba que detecta un estado FALTANTE se disfraza de otra: el hueco entre el saldo final de un mes y el inicial del siguiente dejaría de tener nombre propio',
      },
      {
        archivo: 'src/cli/bank-command.ts',
        de: 'return checkExitCode(',
        a: 'return 0 || checkExitCode(',
        porque: 'un extracto con hallazgo bloqueante sale 0 y cualquier guion de cierre lo da por bueno: el §4.1 del catálogo exige 4',
      },
    ],
    evaluar: () => {
      // El catálogo las nombra una por una (fila 1165) y exige salida 4. Son
      // el producto entero de este tramo: importar un extracto sin poder
      // comprobarlo es volver a creerle al archivo.
      const checks = codigoDe('src/services/banking/statement-checks.ts');
      const LAS_SIETE = [
        'cadena-de-saldos',
        'continuidad',
        'huecos-y-traslapes',
        'identidad',
        'moneda',
        'secuencia',
        'reversos',
      ];
      const faltan = LAS_SIETE.filter((c) => !new RegExp(`check: '${c}'`).test(checks));
      if (faltan.length > 0) {
        return falla(`de las siete pruebas de integridad del extracto faltan: ${faltan.join(', ')}`);
      }

      // Y VIVEN SEPARADAS DE LA BASE. Una comprobación que sólo se puede
      // ejercitar con Postgres detrás es una comprobación que nadie prueba, y
      // acaba siendo la que miente.
      if (/\bfrom '\.\.\/\.\.\/database\/connection\.js'/.test(checks)) {
        return falla('las siete pruebas se ataron a la base: dejan de poder ejercitarse sobre datos en memoria');
      }

      // El 4 se ancla en la LLAMADA, no en el import: importar checkExitCode y
      // no usar su resultado es el falso verde clásico de esta familia.
      const sale4 = /return checkExitCode\(\s*\n?\s*\{ blocking:/.test(codigoDe('src/cli/bank-command.ts'));
      return sale4
        ? ok('las siete pruebas están, viven fuera de la base y el hallazgo bloqueante sale 4')
        : falla('`bank statement check` dejó de devolver el código de checkExitCode: un extracto roto saldría 0');
    },
  },


  {
    paquete: 'E1.2',
    id: 'early-payment-discount-capped',
    enunciado: 'El descuento por pronto pago tiene cuenta, asiento y un techo que las condiciones fijan',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'if (derecho.applied && descuento.greaterThan(derecho.discountAmount)) {',
        a: 'if (false) {',
        porque: 'el techo del descuento se apaga: tomar más de lo pactado volvería a pasar por pronto pago en vez de por pago corto',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "account_id: requireRole(roles, 'devolucion_compras'),",
        a: "account_id: requireRole(roles, 'cxp'),",
        porque: 'el contra-costo se convierte en la propia cuenta de control: el descuento dejaría de reducir la compra y el pasivo se cancelaría solo',
      },
    ],
    evaluar: () => {
      // El descuento se INSERTABA en payment_applications y no participaba en
      // nada más: ni bajaba el saldo ni entraba en el asiento, así que el
      // proveedor quedaba debiendo el descuento para siempre. Se rechazaba en
      // voz alta alegando que faltaba «una cuenta de ingreso por descuentos en
      // la capa de roles» — y la cuenta llevaba sembrada desde el principio
      // (5200, contra-costo, espejo del 4400 de las ventas). Lo que faltaba no
      // era la cuenta: era atarla.
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // 1. La cuenta existe en el mapa de roles, que es de donde el asiento la saca.
      if (!/devolucion_compras:\s*'5200'/.test(codigoDe('src/services/xml-ingestion/account-roles-seed.ts'))) {
        return falla('el rol devolucion_compras perdió su cuenta: el descuento no tendría dónde abonarse');
      }

      // 2. Los DOS asientos lo abonan de verdad: el del pago directo y el de
      //    la aplicación posterior. Se CUENTAN, no se busca «alguna»
      //    ocurrencia — son gemelos textuales, y un ancla de presencia se
      //    conforma con encontrar el otro. El arnés lo cobró: mutar la línea
      //    del primero dejaba el criterio en verde señalando al segundo.
      const abonos = (
        post.match(
          /account_id: requireRole\(roles, 'devolucion_compras'\),\s*\n\s*debit_amount: null,\s*\n\s*credit_amount: descuento/g
        ) ?? []
      ).length;
      if (abonos !== 2) {
        return falla(
          `el descuento se abona a devolucion_compras en ${abonos} de los 2 asientos que lo admiten ` +
            '(el del pago y el de la aplicación posterior)'
        );
      }

      // 3. El pasivo se extingue por efectivo + descuento (+ condonación): si
      //    el cargo a cxp fuera sólo del efectivo, el asiento cuadraría igual
      //    y el gasto quedaría abierto por el descuento — mudo.
      if (!/debit_amount: total\.plus\(descuento\)\.plus\(condonado\)\.toFixed\(4\)/.test(post)) {
        return falla('el cargo a la cuenta de control dejó de cubrir todo lo que deja de deberse');
      }

      // 4. Y EL TECHO. `earlyPaymentDiscount` sabe cuánto conceden unas
      //    condiciones «2/10 net 30»; sin este guardia, tomar 500 sobre un
      //    descuento de 20 pasaría por pronto pago en vez de por el pago corto
      //    que es —el que exige motivo escrito. Se ancla el `throw`, no la
      //    llamada: comprobar y no actuar es la fuga clásica.
      const techo = /if \(derecho\.applied && descuento\.greaterThan\(derecho\.discountAmount\)\) \{[\s\S]{0,400}?throw new ValidationError\(/.test(svc);
      return techo
        ? ok('5200 recibe el descuento en el asiento, el pasivo se extingue entero y el techo lo fijan las condiciones del gasto')
        : falla('el descuento ya no se topa contra lo que las condiciones conceden: tomar de más volvería a pasar por pronto pago');
    },
  },

  {
    paquete: 'E1.2',
    id: 'short-payment-clears-parked-iva',
    enunciado: 'Un gasto cerrado con pago corto no deja IVA vivo en la cuenta de pendientes',
    mutantes: [
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: 'ivaNoAcreditablePorGasto.set(app.invoiceId, ivaCondonado.toFixed(4));',
        a: 'ivaCondonado = new Decimal(0);',
        porque: 'el IVA de la parte condonada deja de salir de 1135: un gasto CERRADO conservaría impuesto aparcado que nadie podrá vaciar nunca',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: 'const costoCondonado = condonado.minus(ivaYaSalido);',
        a: 'const costoCondonado = condonado;',
        porque: 'la parte de IVA se abonaría DOS veces —a 1135 y a la cuenta del pago corto— y el asiento saldría descuadrado por el importe del impuesto',
      },
    ],
    evaluar: () => {
      // Bajo flujo de efectivo el IVA acreditable espera en 1135 hasta que se
      // paga. Cerrar un gasto pagando de menos crea un caso que el sistema no
      // tenía: el impuesto de la parte que NO se pagó nunca va a ser
      // acreditable, y si sólo se libera la parte pagada queda un resto vivo
      // en 1135 de un documento sin saldo — un residuo que ningún informe
      // sabe explicar y que ya no se puede vaciar, porque el gasto que lo
      // justificaba está cerrado. Sale en el mismo asiento, y NO hacia 1130:
      // no se acredita lo que no se pagó.
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // El reparto es proporcional al peso del IVA en el total del gasto...
      if (!/condonadoAqui\s*\n?\s*\.times\(app\.taxAmount\)\s*\n?\s*\.dividedBy\(app\.totalAmount\)/.test(post)) {
        return falla('el IVA condonado dejó de repartirse en proporción al impuesto del gasto');
      }
      // ...y se topa con lo que de verdad queda aparcado tras la liberación:
      // sacar de 1135 más de lo que hay dejaría la cuenta en negativo.
      if (!/const restaAparcado = new Decimal\(parked\)\.minus\(liberable\);/.test(post)) {
        return falla('el IVA condonado ya no se topa contra lo que queda aparcado: podría vaciar 1135 por debajo de cero');
      }
      // Va contra `from` (1135), no contra `to` (1130): acreditarlo sería
      // deducir un impuesto que nadie pagó.
      if (!/account_id: requireRole\(ivaRoles, from\),\s*\n\s*debit_amount: null,\s*\n\s*credit_amount: ivaCondonado\.toFixed\(4\)/.test(post)) {
        return falla('el IVA de la parte condonada ya no sale de la cuenta de pendientes');
      }

      // Y SE ANOTA POR GASTO. Sin esta línea el importe sigue posteándose,
      // pero en CERO —el arnés lo demostró: anular ivaCondonado justo antes
      // del push dejaba las tres anclas anteriores intactas y el criterio en
      // verde—. El mapa no es contabilidad de adorno: es lo que el llamador
      // resta del costo condonado para no abonar el impuesto dos veces.
      if (!/ivaNoAcreditablePorGasto\.set\(app\.invoiceId, ivaCondonado\.toFixed\(4\)\);/.test(post)) {
        return falla('el IVA condonado ya no se anota por gasto: el asiento lo abonaría en cero y el residuo volvería a 1135');
      }

      // Y ESE RESTO se descuenta del abono al pago corto. Si no, la parte de
      // impuesto se abonaría dos veces —a 1135 y a la cuenta de condonación—
      // y el asiento saldría descuadrado justo por el IVA.
      const resta = /const costoCondonado = condonado\.minus\(ivaYaSalido\);/.test(post);
      return resta
        ? ok('el IVA de lo condonado sale de 1135 proporcional, topado y anotado, y no se abona dos veces')
        : falla('el abono del pago corto dejó de restar el IVA que ya salió de 1135: el asiento se descuadraría por el impuesto');
    },
  },

  {
    paquete: 'E1.2',
    id: 'payment-applied-without-moving-cash',
    enunciado: 'Un pago ya hecho se puede repartir después, sin volver a mover el efectivo',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'if (total.greaterThan(remanente)) {',
        a: 'if (false) {',
        porque: 'se podría aplicar más de lo que el pago tiene sin repartir: el anticipo quedaría en negativo y el auxiliar dejaría de cuadrar',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "sourceType: 'vendor_application'",
        a: "sourceType: 'vendor_payment'",
        porque: 'la aplicación se disfraza del pago que la originó: la conciliación contaría dos veces el mismo movimiento de efectivo',
      },
    ],
    evaluar: () => {
      // Una tesorería real transfiere PRIMERO —un importe global al proveedor,
      // cerrando la semana— y decide DESPUÉS contra cuáles de sus facturas
      // abiertas iba. Hasta F04 el único instante en que un pago podía tocar
      // un gasto era el de registrarlo, así que ese dinero quedaba en 1150 sin
      // forma de repartirlo nunca.
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      if (!/export async function applyVendorPayment\(/.test(svc)) {
        return falla('no existe applyVendorPayment: un pago global seguiría sin poder repartirse');
      }
      // El efectivo NO se vuelve a mover: el asiento de la aplicación cambia
      // anticipo por cuenta de control, y nada más. Si tocara el banco,
      // contaría dos veces una salida que ya se posteó.
      const cuerpo = /export async function postVendorApplicationEntry\(([\s\S]*?)\n\}/.exec(post)?.[1] ?? '';
      if (/requireRole\((?:roles|[a-zA-Z]+), 'banco'\)/.test(cuerpo)) {
        return falla('el asiento de la aplicación toca el banco: el efectivo ya salió con el pago y se estaría contando dos veces');
      }
      // Y la lectura del pago va ACOTADA POR ENTIDAD dentro del SQL: un pago
      // de otro inquilino no se aplica ni conociendo su id.
      if (!/FROM vendor_payments WHERE id = \$1 AND entity_id = \$2 FOR UPDATE/.test(svc)) {
        return falla('el pago se lee sin acotar por entidad o sin candado: la frontera del inquilino se cruzaría por id');
      }
      // La aplicación lleva su PROPIO source_type. Disfrazarla del pago que
      // la originó haría que cualquier conciliación que agrupe por origen
      // contara dos veces el mismo movimiento de efectivo.
      if (!/sourceType: 'vendor_application'/.test(post)) {
        return falla('el asiento de la aplicación perdió su source_type propio: se confundiría con el del pago');
      }

      // El tope contra el remanente, CONTADO en los dos eventos que reparten
      // saldo a cuenta (cobro y pago). Son gemelos textuales: buscar «alguno»
      // deja vivo al mutante que rompe el otro, y el arnés lo cobró.
      const topes = (svc.match(/if \(total\.greaterThan\(remanente\)\) \{\s*\n\s*throw new ValidationError\(/g) ?? []).length;
      return topes === 2
        ? ok('applyVendorPayment reparte un pago vivo sin tocar el banco, acotado por entidad, con source_type propio y topado en los dos eventos')
        : falla(
            `el tope contra el remanente sobrevive en ${topes} de los 2 eventos que reparten saldo a cuenta: ` +
              'sin él se repartiría dinero que el pago no tiene'
          );
    },
  },
  {
    paquete: 'E1.2',
    id: 'exchange-rate-refuses-to-pick-a-source',
    enunciado:
      'Con dos fuentes publicadas el mismo día, el tipo de cambio no se elige por orden físico: el esquema se niega y las nombra',
    evaluar: () => {
      // POR QUÉ NACE (T1, issue #88). `get_exchange_rate()` se escribió en la
      // 001 para un mundo de UNA tasa por par y día. La 057 cambió ese mundo:
      // metió `source` en la unicidad para que DOF y el FIX de Banxico
      // convivieran a propósito. La función no se redefinió, así que su
      // `ORDER BY effective_date DESC LIMIT 1` sin desempate contestaba la fila
      // que Postgres leyera primero. Eso es orden FÍSICO: se mueve con un
      // VACUUM, una reescritura o una restauración de respaldo, y las dos
      // respuestas eran indistinguibles para el sistema.
      //
      // Elegir DOF sobre FIX es criterio FISCAL, y esta casa ya decidió dónde
      // se decide eso: la política `fuente_tipo_cambio`. Así que el esquema no
      // elige — levanta FX001 — y quien sabe cuál quiere lo pide.
      const sql = crudoDe('src/database/migrations/084_the_rate_is_not_chosen_by_physical_order.sql');
      if (!/p_source\s+VARCHAR\(100\)\s+DEFAULT\s+NULL/.test(sql)) {
        return falla(
          'la 084 dejó de admitir `p_source`: sin ella no hay forma de pedir una fuente y la ' +
            'ambigüedad vuelve a resolverse sola'
        );
      }
      const raises = sql.match(/USING ERRCODE = 'FX001'/g) ?? [];
      if (raises.length < 2) {
        return falla(
          `la 084 levanta FX001 en ${raises.length} de los dos caminos que leen una fila ` +
            '(directo e inverso): el que no lo haga vuelve a contestar por orden físico'
        );
      }
      // Y el servicio tiene que TRADUCIRLO. Un FX001 crudo dice que algo pasó;
      // el operador necesita las fuentes y la bandera que las desempata.
      const svc = crudoDe('src/services/fx/rate-service.ts');
      if (!/code !== 'FX001'/.test(svc) || !/FX_AMBIGUOUS_SOURCE/.test(svc)) {
        return falla(
          'rate-service dejó de traducir FX001: `fx rate show` volvería a escupir un error de ' +
            'Postgres sin decir qué fuentes hay ni cómo elegir una'
        );
      }
      if (!/--source/.test(crudoDe('src/cli/fx-command.ts'))) {
        return falla('`fx rate show` se quedó sin --source: no hay cómo pedir la fuente que se quiere');
      }
      return ok('la ambigüedad de fuente se niega en el esquema, se traduce en el servicio y se resuelve con --source');
    },
    mutantes: [
      {
        archivo: 'src/database/migrations/084_the_rate_is_not_chosen_by_physical_order.sql',
        de: "                USING ERRCODE = 'FX001';",
        a: '                ;',
        porque:
          'el esquema vuelve a elegir entre DOF y FIX por el orden en que lea las filas, y la ' +
          'respuesta cambia sola con un VACUUM sin que nada lo diga',
      },
    ],
  },
  {
    paquete: 'E1.2',
    id: 'cfdi-declared-zero-is-not-an-absence',
    enunciado:
      'Un cero declarado en un CFDI se conserva, y un exento no se cuenta como venta a tasa 0 %',
    mutantes: [
      {
        archivo: 'src/services/xml-ingestion/cfdi-parser.ts',
        de: "isDeclared(i['@_TasaOCuota']) ? parseFloat",
        a: "i['@_TasaOCuota'] ? parseFloat",
        porque:
          'vuelve a preguntar por la VERDAD del atributo: con parseAttributeValue un TasaOCuota="0.000000" llega como el número 0, se borra, y con él lo único que distingue una tasa 0 % de un exento',
      },
      {
        archivo: 'src/services/xml-ingestion/cfdi-parser.ts',
        de: "if (clave(t.impuesto) !== '002' || t.tipoFactor !== 'Tasa') continue;",
        a: "if (clave(t.impuesto) !== '002') continue;",
        porque:
          'quita la puerta del tipo de factor: un traslado exento —que no declara tasa— vuelve a caer en el cubo de 0 %, y el desglose declara como acreditable una operación que no lo es',
      },
      {
        archivo: 'src/services/xml-ingestion/cfdi-parser.ts',
        de: 'else if (rate === 0) iva0 = iva0.plus(t.base);',
        a: 'else if (rate === 0) iva0 = iva0.plus(t.importe ?? 0);',
        porque:
          'vuelve a sumar el importe en el cubo de tasa 0, que vale cero por definición: total_iva_0 regresa a ser siempre 0.00 con la columna llena de ceros que parecen un dato',
      },
      {
        archivo: 'src/services/xml-ingestion/cfdi-facts.ts',
        de: "if (t.tipoFactor === 'Exento') {",
        a: "if (t.tipoFactor === 'Ninguno') {",
        porque:
          'los hechos dejan de reconocer el exento y lo devuelven al cubo de tasa 0: importeExento sale en cero e ivaTasaCero declara de más, justo la cifra contra la que se calcula el acreditamiento proporcional',
      },
    ],
    evaluar: () => {
      // #126 (T19). El defecto de origen era una línea, pero la línea borraba un
      // BIT: con `parseAttributeValue` un «0.00» declarado llega como el número
      // 0, y preguntar por su verdad lo vuelve indistinguible de un atributo
      // ausente. Borrado ese bit, las dos copias que reparten el IVA por tasa
      // quedaron cada una a medias y ninguna PODÍA estar entera — el parser
      // excluía el exento por accidente y perdía el cero; los hechos sumaban
      // bien la base y no sabían qué era un exento.
      //
      // Por eso esto censa la FORMA y no el arreglo: el día que aparezca un
      // tercer repartidor, lo que tiene que sonar es el censo.
      const parser = 'src/services/xml-ingestion/cfdi-parser.ts';
      const hechos = 'src/services/xml-ingestion/cfdi-facts.ts';
      for (const f of [parser, hechos]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      // 1. CENSO: ningún atributo del CFDI se declara ausente por ser falsy.
      //    La forma acusada es exactamente la que BORRA EL BIT —preguntar por
      //    la verdad del atributo y responder `undefined`, o sea «no vino»—.
      //    Un `: 1` o un `|| 'MXN'` sustituyen un valor por otro y tendrán su
      //    propia discusión; no fingen que el emisor no declaró nada, y meterlos
      //    aquí sería la acusación de más que hace que se deje de leer el informe.
      const porVerdad = dondeAparece(/\['@_\w+'\]\s*\?[^;{}]{0,120}?:\s*undefined/, ['src'], true);
      if (porVerdad.length > 0) {
        return falla(
          `${porVerdad.join(', ')} vuelve a preguntar por la VERDAD de un atributo del CFDI para ` +
            'declararlo ausente: un «0.00» que el emisor SÍ declaró llega como el número 0 y se ' +
            'borra, quedando indistinguible de un atributo que nunca vino (#126)'
        );
      }
      if (!/v !== undefined && v !== null && v !== ''/.test(codigoDe(parser))) {
        return falla(
          'isDeclared dejó de medir presencia: si vuelve a medir verdad, un cero declarado se borra ' +
            'igual que si el atributo faltara, y el censo de arriba ya no lo ve porque la forma cambió de sitio (#126)'
        );
      }

      // 2. CENSO: quien reparte el IVA por tasa tiene que nombrar el exento.
      //    Ante el SAT son dos renglones distintos y sólo la tasa 0 % se acredita.
      const reparten = dondeAparece(/tasaOCuota/, ['src'], true);
      if (reparten.length < 2) {
        return falla(
          `sólo ${reparten.length} archivo(s) leen tasaOCuota y eran 2: si el reparto por tasa se mudó, ` +
            'este censo dejó de vigilar nada (#126)'
        );
      }
      const mudos = reparten.filter((f) => !/tipoFactor\s*[!=]==\s*'(Tasa|Exento)'/.test(codigoDe(f)));
      if (mudos.length > 0) {
        return falla(
          `${mudos.join(', ')} reparte el IVA por tasa sin mirar el TipoFactor: un exento no declara ` +
            'tasa, cae en el cubo de 0 % y se declara acreditable una operación que no lo es (#126)'
        );
      }

      // 3. Y el cubo de tasa 0 se mide por la BASE: su importe vale cero por definición.
      const porImporte = reparten.filter((f) => !/===\s*0\)[^;\n]*\bbase\b/i.test(codigoDe(f)));
      if (porImporte.length > 0) {
        return falla(
          `${porImporte.join(', ')} suma el importe en el cubo de tasa 0, que es cero por definición: ` +
            'la columna se llena de ceros que parecen un dato y el despacho lee que no hubo tales ventas (#126)'
        );
      }

      return existe('tests/xml-ingestion/cfdi-zero-rate-is-not-absence.spec.ts')
        ? ok(
            `${reparten.length} repartidores del IVA por tasa distinguen el exento y miden la tasa 0 por su base`
          )
        : falla(
            'no hay prueba del cero declarado: es lo único que separa «el emisor declaró 0.00» de «no declaró nada»'
          );
    },
  },
];
