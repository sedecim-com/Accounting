import * as fs from 'node:fs';
import {
  codigoDe,
  consumidoresDe,
  type Criterio,
  crudoDe,
  falla,
  ok,
  rutaDe,
} from './shared.js';

// ============================================================
// THE E0.3 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E0_3: Criterio[] = [

  // ---- E0.3 · Bitácora de auditoría ----
  {
    paquete: 'E0.3',
    id: 'posting-audits-in-same-transaction',
    enunciado: 'El motor de posteo deja rastro en la misma transacción que el asiento',
    evaluar: () => {
      const p = 'src/services/accounting/posting.ts';
      const s = codigoDe(p);
      const n = (s.match(/registrarAuditoria/g) ?? []).length;
      return n >= 4
        ? ok(`${n} puntos de auditoría en posting.ts`)
        : falla(`sólo ${n}: un asiento creado por la CLI o el agente no deja rastro`);
    },
  },
  {
    paquete: 'E0.3',
    id: 'audit-log-immutable-in-database',
    enunciado: 'La bitácora no se puede reescribir: UPDATE y DELETE fallan en Postgres',
    evaluar: () => {
      const migs = fs.readdirSync(rutaDe('src/database/migrations'));
      const protege = migs.some((m) => {
        const s = crudoDe('src/database/migrations', m);
        return /audit_log/.test(s) && /(REVOKE|CREATE RULE|BEFORE UPDATE OR DELETE)/i.test(s);
      });
      return protege
        ? ok('una migración revoca la reescritura')
        : falla('ninguna migración protege audit_log: el rastro es borrable');
    },
  },
  {
    paquete: 'E0.3',
    id: 'append-only-triggers-match-grants',
    enunciado:
      'Toda bitácora de sólo agregar lleva disparador, y la lista de privilegios la refleja',
    evaluar: () => {
      // Este criterio existe porque el anterior no bastaba, y la forma en que
      // no bastaba es instructiva: `/audit_log/ && /REVOKE/` da verde con un
      // archivo que sólo REVOCA. La migración 014 hacía exactamente eso sobre
      // fiscal_credential_access_log —y sólo FROM PUBLIC, que no toca el GRANT
      // explícito a mnemosine_app—, así que un criterio calcado habría
      // declarado protegida una bitácora que cualquiera podía reescribir.
      //
      // Aquí se exige la capa que aguanta: el disparador. Y se cruzan las TRES
      // listas que hoy tienen que decir lo mismo y que nadie comparaba:
      //   · las tablas con disparador, leídas de las migraciones;
      //   · el array `append_only` de rls-policies.sql, que corre DESPUÉS de
      //     todas las migraciones y devuelve la escritura a lo que no esté;
      //   · el mismo array en scripts/provision-roles.sql, cuyo GRANT sobre
      //     ALL TABLES la devuelve otra vez en cada reprovisionado.
      // Una tabla con disparador que falte de cualquiera de los dos arrays
      // pierde la capa barata en silencio; un nombre en un array sin
      // disparador es una protección que sólo existe en la lista.
      //
      // El SQL se lee SIN comentarios. `codigoDe` no sirve aquí: su
      // `sinComentarios` quita `/* */` y `//` —los de TypeScript— y deja
      // pasar `--`, que es el de SQL. Con la versión anterior, comentar la
      // tabla dentro del array bastaba para que este criterio siguiera en
      // verde mientras Postgres la dejaba fuera. Se comprobó ejecutándolo.
      const sinComentariosSql = (t: string): string =>
        t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

      const dir = 'src/database/migrations';
      const sql = sinComentariosSql(
        fs
          .readdirSync(rutaDe(dir))
          .map((m) => crudoDe(dir, m))
          .join('\n')
      );

      // Se aceptan las formas equivalentes que Postgres acepta: `CREATE OR
      // REPLACE TRIGGER`, el nombre de tabla entrecomillado, y los eventos en
      // cualquier orden. Exigir la secuencia literal `UPDATE OR DELETE` ponía
      // en rojo código correcto escrito `DELETE OR UPDATE`, que es el modo en
      // que un criterio deja de creerse y se desactiva.
      const eventos = new Map<string, Set<string>>();
      const funcionDe = new Map<string, Set<string>>();
      const RE_TRIGGER =
        /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?\w+"?\s+BEFORE\s+([A-Za-z\s]+?)\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi;
      for (const m of sql.matchAll(RE_TRIGGER)) {
        const tabla = m[2];
        const evs = m[1].toUpperCase().split(/\s+OR\s+/).map((e) => e.trim());
        const set = eventos.get(tabla) ?? new Set<string>();
        for (const e of evs) set.add(e);
        eventos.set(tabla, set);
        const fn = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?/i.exec(m[3]);
        if (fn) {
          const fns = funcionDe.get(tabla) ?? new Set<string>();
          fns.add(fn[1]);
          funcionDe.set(tabla, fns);
        }
      }

      // «Hay disparador» y «el disparador rechaza» son cosas distintas: uno
      // cuyo cuerpo hiciera `RETURN NEW` satisfaría lo primero y no protegería
      // nada. Se exige que la función que cuelga del disparador levante
      // excepción — Y que rechace SIEMPRE: desde la 041 (R1) existe una
      // segunda clase de protección, la inmutabilidad CONDICIONAL del mayor
      // (rechaza lo posteado, deja pasar el resto con RETURN NEW). Esa clase
      // NO es una bitácora de sólo-agregar y no debe entrar a los arrays
      // append_only, que le revocarían el UPDATE que el posteo necesita. El
      // discriminador es estructural: una función de sólo-agregar no tiene
      // ningún camino que devuelva NEW.
      const rechaza = (fn: string): boolean => {
        const i = new RegExp(
          `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?`,
          'i'
        ).exec(sql);
        if (i === null) return false;
        const cuerpo = sql.slice(i.index, i.index + 2000);
        return /RAISE\s+EXCEPTION/i.test(cuerpo) && !/RETURN\s+NEW/i.test(cuerpo);
      };

      const protegidas = new Set<string>();
      const parciales: string[] = [];
      for (const [tabla, evs] of eventos) {
        const completa =
          evs.has('UPDATE') && evs.has('DELETE') && evs.has('TRUNCATE');
        const fns = [...(funcionDe.get(tabla) ?? [])];
        const muerden = fns.length > 0 && fns.every(rechaza);
        if (completa && muerden) {
          protegidas.add(tabla);
        } else if (evs.has('UPDATE') || evs.has('DELETE')) {
          // Sólo se reporta lo que PARECE una bitácora cerrada y no lo está.
          // Un disparador BEFORE UPDATE cualquiera —hay varios de
          // `updated_at`— no entra aquí porque su función no levanta excepción.
          if (muerden) {
            parciales.push(
              `${tabla}: rechaza ${[...evs].sort().join('/')} pero le falta ` +
                `${['UPDATE', 'DELETE', 'TRUNCATE'].filter((e) => !evs.has(e)).join(' y ')}` +
                (evs.has('TRUNCATE') ? '' : ' — un TRUNCATE no dispara triggers de fila')
            );
          }
        }
      }
      if (parciales.length > 0) return falla(parciales.join('; '));
      if (protegidas.size === 0) {
        return falla('ninguna tabla lleva disparador de sólo-agregar que rechace');
      }

      const arrayDe = (rel: string): Set<string> | null => {
        const txt = sinComentariosSql(crudoDe(rel));
        const m = /append_only\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(txt);
        if (!m) return null;
        return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      };

      const fuentes: Array<{ rel: string; porque: string }> = [
        {
          rel: 'src/database/rls-policies.sql',
          porque: 'corre después de migrar y su GRANT general les devuelve la escritura',
        },
        {
          rel: 'scripts/provision-roles.sql',
          porque: 'su GRANT sobre ALL TABLES se la devuelve en cada reprovisionado',
        },
      ];

      const problemas: string[] = [];
      for (const f of fuentes) {
        const lista = arrayDe(f.rel);
        if (!lista) {
          problemas.push(`${f.rel}: no se encontró el array append_only — ${f.porque}`);
          continue;
        }
        const faltan = [...protegidas].filter((t) => !lista.has(t));
        const sobran = [...lista].filter((t) => !protegidas.has(t));
        if (faltan.length > 0) {
          problemas.push(`${f.rel}: falta ${faltan.join(', ')} — ${f.porque}`);
        }
        if (sobran.length > 0) {
          problemas.push(
            `${f.rel}: nombra ${sobran.join(', ')} sin disparador que lo respalde ` +
              '(el dueño del esquema ignora los privilegios de tabla)'
          );
        }
      }
      if (problemas.length > 0) return falla(problemas.join('; '));

      return ok(
        `${protegidas.size} bitácoras con disparador que rechaza y las dos listas de ` +
          `privilegios al día: ${[...protegidas].sort().join(', ')}`
      );
    },
  },
  {
    paquete: 'E0.3',
    id: 'audit-log-redacts-encrypted-fields',
    enunciado: 'La bitácora no guarda en claro lo que las tablas cifran',
    evaluar: () => {
      // S1: el middleware de auditoría escribía JSON.stringify(req.body)
      // entero en audit_log.new_values — un alta de empleado dejaba ssn y
      // bank_account EN CLARO en la única tabla que, por diseño de la 033,
      // no admite remediación. Lo que se exige: el stringify crudo no existe
      // y la redacción cubre, como mínimo, los campos que los servicios
      // cifran hoy (ssn, clabe, bank_account*, password, key/cer).
      const m = codigoDe('src/api/rest/middleware/audit.ts');
      if (/JSON\.stringify\(req\.body\)/.test(m)) {
        return falla('el middleware volvió al stringify crudo: los secretos vuelven a la bitácora inmutable');
      }
      if (!/redactarSensibles/.test(m)) {
        return falla('no hay redacción en el middleware de auditoría');
      }
      const minimos = ['ssn', 'clabe', 'bank_account', 'password', 'key', 'cer'];
      const faltan = minimos.filter((c) => !new RegExp(`'${c}'`).test(m));
      return faltan.length === 0
        ? ok('el cuerpo se redacta antes de tocar la bitácora, con los campos cifrados cubiertos')
        : falla(`la lista de redacción no cubre: ${faltan.join(', ')} — un campo que se cifra en tabla no puede viajar en claro al rastro`);
    },
  },
  {
    paquete: 'E0.3',
    id: 'money-lifecycle-audit-trail',
    enunciado: 'Los ciclos de vida del dinero dejan su propio rastro, no sólo su asiento',
    evaluar: () => {
      // R1: emitir/anular una factura, aprobar la del proveedor y registrar
      // un pago sólo auditaban su asiento derivado — «quién emitió» o «quién
      // registró el pago» no estaba en ninguna parte. Los tres servicios
      // escriben registrarAuditoria DENTRO de sus transacciones existentes.
      const consumidores = consumidoresDe('registrarAuditoria', 'audit-log.ts');
      const exigidos = [
        'src/services/ar/invoice-service.ts',
        'src/services/ap/bill-service.ts',
        'src/services/payments/payment-service.ts',
      ];
      const faltan = exigidos.filter((f) => !consumidores.includes(f));
      return faltan.length === 0
        ? ok(`el rastro cubre los ciclos de vida (${consumidores.length} escritores en total)`)
        : falla(`ciclos de vida sin rastro propio: ${faltan.join(', ')}`);
    },
  },

  {
    paquete: 'E0.3',
    id: 'reconciliation-approval-sealed-snapshot',
    enunciado: 'La firma congela lo que se firmó, y su hash no depende del orden',
    mutantes: [
      {
        archivo: 'src/database/migrations/055_la_firma_y_el_sello.sql',
        de: "CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL))",
        a: 'CHECK (true)',
        porque: 'una sesión podría quedar contabilizada sin decir cuándo ni por quién',
      },
      {
        archivo: 'src/database/migrations/055_la_firma_y_el_sello.sql',
        de: "CHECK (status NOT IN ('approved', 'posted') OR approval_hash IS NOT NULL)",
        a: 'CHECK (true)',
        porque: 'se llegaría a approved sin instantánea sellada: la firma vuelve a ser una palabra que alguien escribe, que es de lo que este módulo viene',
      },
    ],
    evaluar: () => {
      // Una aprobación sin fecha, sin firmante y sin instantánea es
      // indistinguible de un UPDATE — que es la forma exacta del defecto
      // histórico de este módulo. Y la instantánea es lo que permite que un
      // auditor pregunte «¿esto es lo que se aprobó?» seis meses después, en
      // vez de mirar el estado de HOY con las partidas ya reclasificadas.
      const sql = crudoDe('src/database/migrations/055_la_firma_y_el_sello.sql');
      const svc = codigoDe('src/services/banking/reconciliation-service.ts');

      // Se ancla el CUERPO de cada guardia y no su nombre. Un CHECK puede
      // conservar el nombre y quedarse en `CHECK (true)`, que es exactamente
      // el mutante que sobrevivió a la primera versión de este criterio.
      const guardias: Array<[string, RegExp]> = [
        ['sesion_firma_coherente', /approved_by IS NOT NULL AND approved_at IS NOT NULL/],
        ['sesion_aprobada_con_firma', /status NOT IN \('approved', 'posted'\) OR approval_hash IS NOT NULL/],
        ['sesion_contabilizada_con_rastro', /status <> 'posted' OR \(posted_at IS NOT NULL AND posted_by IS NOT NULL\)/],
      ];
      const faltan = guardias
        .filter(([nombre, cuerpo]) => !new RegExp(`CONSTRAINT ${nombre}`).test(sql) || !cuerpo.test(sql))
        .map(([nombre]) => nombre);
      if (faltan.length > 0) {
        return falla(`la firma perdió guardias en la base (o quedaron vacíos de contenido): ${faltan.join(', ')}`);
      }
      // EL HASH TIENE QUE SER DETERMINISTA o la pregunta no se puede
      // contestar: el mismo contenido serializado en otro orden daría otro
      // hash, y «no casa» dejaría de significar «alguien lo cambió».
      if (!/export function hashDeInstantanea\(/.test(svc)) {
        return falla('no hay una función única que selle la instantánea: dos llamadores producirían dos hashes del mismo contenido');
      }
      // Y LA TOLERANCIA CON LA QUE SE CERRÓ SE PERSISTE. Sin ella, la firma
      // reevaluaba el cuadre con la de hoy y la instantánea sellada de un
      // cierre legítimo con residual decía que la cuenta NO cuadraba: el único
      // documento cuyo trabajo es no contradecir al cierre lo contradecía.
      const persiste = /closing_tolerance DECIMAL\(19,4\)/.test(sql) && /closing_tolerance = \$\d+/.test(svc);
      return persiste
        ? ok('la firma va entera o no va, su hash es determinista, y reevalúa con la tolerancia del cierre y no con la de hoy')
        : falla('la tolerancia del cierre no se persiste o no se escribe: la instantánea firmada volvería a contradecir al cierre que firma');
    },
  },

  // ---- F05c · La sesión que cuadra ----

  {
    paquete: 'E0.3',
    id: 'reconciliation-balanced-requires-arithmetic',
    enunciado: 'Una sesión no puede declararse cuadrada sin que la aritmética conste',
    mutantes: [
      {
        archivo: 'src/database/migrations/054_la_sesion_que_cuadra.sql',
        de: '            OR arithmetic_computed_at IS NOT NULL',
        a: '            OR true',
        porque: 'vuelve a caber el defecto histórico: un UPDATE poniendo balanced sin haber calculado nada, que el cierre de periodo lee como prueba de que la cuenta se verificó',
      },
      {
        archivo: 'src/services/banking/reconciliation-service.ts',
        de: '              arithmetic_computed_at = NOW(),',
        a: '              beginning_balance = beginning_balance,',
        porque: 'el único escritor legítimo deja de dejar constancia: la base rechazaría el cierre y `close` quedaría roto, que es mejor que cerrar en falso pero sigue siendo un fallo',
      },
    ],
    evaluar: () => {
      // EL DEFECTO HISTÓRICO DE ESTE MÓDULO, escrito por su propio código:
      // `POST /reconciliations/:id/complete` era un UPDATE poniendo
      // status='balanced' y nada más. Nunca calculó el saldo de libros, nunca
      // lo comparó con el del banco, nunca miró si quedaba un movimiento sin
      // cotejar. Las columnas conservaban su DEFAULT 0 y la sesión reportaba
      // «variance 0» — un cero que significa «nadie restó nada», mostrado como
      // «la cuenta cuadra». Y period-close lo lee como evidencia de cierre.
      //
      // POR ESO EL INVARIANTE NO ES «VARIACIÓN CERO». La variación valía cero,
      // y valía cero por DEFAULT, que es justo lo contrario de haberla
      // calculado: un CHECK sobre ella habría dejado pasar el defecto entero.
      // Lo que se exige es que la aritmética CONSTE.
      const sql = crudoDe('src/database/migrations/054_la_sesion_que_cuadra.sql');

      if (!/CONSTRAINT sesion_balanceada_con_aritmetica/.test(sql)) {
        return falla('desapareció el guardia del cuadre: vuelve a poderse declarar balanceada una sesión que nadie calculó');
      }
      if (!/OR arithmetic_computed_at IS NOT NULL/.test(sql)) {
        return falla('el CHECK dejó de exigir constancia de la aritmética: es exactamente el hueco por el que pasó el defecto histórico');
      }
      // Y VIVE EN LA BASE, no en el servicio. Un guardia que sólo vive en el
      // servicio protege el camino que alguien recordó, no la tabla — y lo que
      // impidió esto durante un año fue exactamente nada.
      const svc = codigoDe('src/services/banking/reconciliation-service.ts');
      const escribe = /SET status = 'balanced',\s*\n\s*arithmetic_computed_at = NOW\(\),/.test(svc);
      return escribe
        ? ok('«balanceada» exige constancia de la aritmética, y el guardia vive en la base y no en el camino que alguien recuerde')
        : falla('el cierre dejó de dejar constancia de la aritmética al marcar balanced');
    },
  },

  {
    paquete: 'E0.3',
    id: 'reconciliation-adjustment-never-posts',
    enunciado: 'Crear un ajuste de conciliación no alcanza el mayor: nace borrador',
    mutantes: [
      {
        // Inserta CÓDIGO, no un comentario. La primera versión metía
        // `/* createJournalEntry */` y sobrevivía con razón —`codigoDe` quita
        // los comentarios, y un comentario que nombra el mayor no es un camino
        // al mayor—, pero el arnés exige que TODO mutante mate: un control
        // negativo deliberado no cabe en su contrato, así que se sustituye.
        archivo: 'src/services/banking/reconciliation-adjustments.ts',
        de: '    await query(',
        a: '    await createJournalEntry(); await query(',
        porque: 'basta un camino al mayor dentro del creador de ajustes para que su promesa de «nunca contabiliza por su cuenta» sea falsa',
      },
    ],
    evaluar: () => {
      // «Crea COMO BORRADORES … nunca contabiliza por su cuenta» es la promesa
      // literal de la fila 1246. Contabilizar es de F05d, detrás de una firma.
      // La promesa se verifica contra el SERVICIO, no contra la declaración:
      // en F05a la misma comprobación destapó que una familia entera estaba
      // probada y no entregada.
      const svc = codigoDe('src/services/banking/reconciliation-adjustments.ts');
      const alMayor = /createJournalEntry|postJournalEntry|INSERT INTO journal_entries/.exec(svc);
      if (alMayor !== null) {
        return falla(
          `el creador de ajustes alcanza el mayor ("${alMayor[0]}"): la fila promete que nunca contabiliza por su cuenta`
        );
      }
      // Y la columna que lo demuestra queda vacía hasta F05d.
      const sql = crudoDe('src/database/migrations/054_la_sesion_que_cuadra.sql');
      const nace = /journal_entry_id UUID REFERENCES journal_entries\(id\)/.test(sql);
      return nace
        ? ok('el ajuste nace borrador y su asiento queda en NULL hasta que F05d lo contabilice tras una firma')
        : falla('el ajuste perdió el vínculo con su asiento: no se podría saber cuál contabilizó cuál');
    },
  },

  {
    paquete: 'E0.3',
    id: 'reconciled-mark-atomic-unapply-closes',
    enunciado: 'El sello de una partida es todo o nada, y desaplicar lo libera sin borrar el cotejo',
    mutantes: [
      {
        archivo: 'src/database/migrations/052_el_cotejo.sql',
        de: '            (is_reconciled = true AND reconciled_at IS NOT NULL AND reconciliation_id IS NOT NULL)',
        a: '            (is_reconciled = true)',
        porque: 'una partida puede quedar marcada como conciliada sin decir cuándo ni por quién: el sello deja de ser rastreable y nadie puede deshacerlo',
      },
      {
        archivo: 'src/services/banking/match-service.ts',
        de: '          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2',
        a: '          SET unapplied_by = $1, unapply_reason = $2',
        porque: 'la clausura pierde su fecha y el cotejo deshecho sigue contando como vivo en todo índice que filtre por unapplied_at IS NULL',
      },
    ],
    evaluar: () => {
      // El esquema lleva desde 001 reservando `is_reconciled`, `reconciled_at`
      // y `reconciliation_id`, y la 041 las declara el ÚNICO hueco de escritura
      // sobre una línea posteada. Nadie las había escrito nunca. Al escribirlas
      // por primera vez, lo que importa es que vayan JUNTAS: una marca sin
      // fecha ni dueño es una conciliación que no se puede auditar ni deshacer.
      const sql = crudoDe('src/database/migrations/052_el_cotejo.sql');
      const svc = codigoDe('src/services/banking/match-service.ts');

      if (!/CONSTRAINT jel_sello_coherente/.test(sql)) {
        return falla('desapareció el CHECK del sello: una partida podría quedar «conciliada» sin decir cuándo ni por quién');
      }
      if (!/\(is_reconciled = true AND reconciled_at IS NOT NULL AND reconciliation_id IS NOT NULL\)/.test(sql)) {
        return falla('el CHECK dejó de exigir las tres columnas juntas: vuelve a caber el sello a medias');
      }
      // Desaplicar CLAUSURA, no borra — la misma decisión que la 049 tomó para
      // la aplicación de un cobro. Un cotejo deshecho es historia: el auditor
      // pregunta por qué se deshizo y una fila borrada no contesta.
      if (/DELETE FROM reconciliation_matches/.test(svc)) {
        return falla('desaplicar volvió a borrar el cotejo: la pregunta «por qué se deshizo» se queda sin respuesta');
      }
      const clausura = /SET unapplied_at = NOW\(\), unapplied_by = \$\d, unapply_reason = \$\d/.test(svc);
      return clausura
        ? ok('el sello va con fecha y dueño o no va, y desaplicar clausura el cotejo en vez de borrarlo')
        : falla('la clausura del cotejo perdió su fecha: un cotejo deshecho seguiría contando como vivo');
    },
  },

  // ---- S3·sello · El libro que no se puede apagar en silencio ----

  {
    paquete: 'E0.3',
    id: 'guard-triggers-enable-always-watched',
    enunciado: 'Toda garantía del esquema está sellada con ENABLE ALWAYS, y doctor vigila que siga estándolo',
    mutantes: [
      {
        archivo: 'src/database/migrations/058_el_sello_de_las_garantias.sql',
        de: 'ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER journal_entry_lines_posteada_inmutable;',
        a: '-- (sin sellar)',
        porque: 'deja una garantía del mayor en disparador ordinario: una línea de SET session_replication_role la apagaría con las demás y la inmutabilidad de la línea posteada se evapora sin dejar rastro',
      },
      {
        archivo: 'src/ai/doctor-service.ts',
        de: "    checks.push(await checkSelloDeGarantias());",
        a: '    // sin vigilancia del sello',
        porque: 'el sello deja de vigilarse: ENABLE ALWAYS no impide DISABLE TRIGGER, así que sin este chequeo un break-glass no se distingue de un sabotaje y doctor sigue diciendo ok',
      },
    ],
    evaluar: () => {
      const sello = crudoDe('src/database/migrations/058_el_sello_de_las_garantias.sql');
      const doctor = codigoDe('src/ai/doctor-service.ts');

      // LA LISTA SE DERIVA, NO SE ESCRIBE. Los disparadores de garantía se
      // leen de las migraciones que los crean; si mañana alguien añade la
      // garantía número diez y no la sella, este criterio la echa en falta
      // sin que nadie tenga que acordarse de apuntarla. Una lista paralela
      // es justo lo que este proyecto ha pagado ya varias veces.
      const DE_GARANTIA = [
        '033_audit_log_append_only.sql',
        '035_fiscal_credential_log_append_only.sql',
        '041_el_mayor_inviolable.sql',
        '051_la_cuenta_y_el_extracto.sql',
      ];
      const declarados: string[] = [];
      for (const archivo of DE_GARANTIA) {
        const sql = crudoDe(`src/database/migrations/${archivo}`);
        for (const m of sql.matchAll(/CREATE TRIGGER\s+(\w+)/g)) declarados.push(m[1]);
      }
      if (declarados.length === 0) {
        return falla('no se encontró ni un disparador de garantía en las migraciones: el criterio quedó ciego, revisa los nombres de archivo');
      }

      const sinSellar = declarados.filter(
        (t) => !new RegExp(`ENABLE ALWAYS TRIGGER ${t}\\b`).test(sello)
      );
      if (sinSellar.length > 0) {
        return falla(
          `${sinSellar.length} de ${declarados.length} garantías sin ENABLE ALWAYS (${sinSellar.join(', ')}): ` +
            'una línea de SET session_replication_role las apagaría sin tocar el esquema y sin dejar rastro'
        );
      }
      // Y el sello se VIGILA: ENABLE ALWAYS no impide DISABLE TRIGGER, que es
      // legítimo como break-glass. Lo que no puede ser es que no se note.
      // Se ancla la LLAMADA, no el nombre: la afirmación es que doctor lo
      // CORRE, y buscar `checkSelloDeGarantias` a secas la da por cierta con
      // sólo que la función exista definida y sin llamador — que es capacidad
      // huérfana disfrazada de garantía. Tercera vez en este proyecto que la
      // presencia se hace pasar por conducta.
      const vigilado =
        /checks\.push\(await checkSelloDeGarantias\(\)\)/.test(doctor) &&
        /garantia-sellada/.test(doctor) &&
        /tgenabled/.test(doctor);
      return vigilado
        ? ok(`las ${declarados.length} garantías del esquema están selladas, y doctor falla si alguna deja de estarlo`)
        : falla('doctor dejó de leer pg_trigger.tgenabled: apagar una garantía volvería a ser indetectable');
    },
  },

  {
    paquete: 'E0.3',
    id: 'bank-transaction-dedupe-by-database',
    enunciado:
      'La huella del movimiento la IMPONE la base, y el relleno de lo ya importado la alcanza',
    mutantes: [
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '  NEW.content_hash := encode(',
        a: '  NEW.content_hash := COALESCE(NEW.content_hash, encode(',
        porque: 'el llamador recupera el control de la huella: mandando una inventada, deja de identificar la línea y el cotejo pierde su ancla',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: 'amount, description, content_hash\n  ON bank_transactions',
        a: 'amount, description\n  ON bank_transactions',
        porque: 'sin content_hash en la lista vigilada el disparador no corre al escribirla, así que la huella SÍ se puede forjar a mano — y la 058 y banking.md prometen por escrito que no',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: 'UPDATE bank_transactions SET transaction_date = transaction_date;',
        a: 'UPDATE bank_transactions SET content_hash = NULL;',
        porque: 'EL DEFECTO QUE ORIGINÓ #88, que ningún espejo custodiaba: content_hash no está en el UPDATE OF del disparador, así que el relleno no dispara nada y el SET NOT NULL de dos líneas después revienta con 23502 en todo despacho con un solo movimiento',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: 'SET LOCAL row_security = on;\nDO $relleno$',
        a: 'DO $relleno$',
        porque: 'sin el opt-in y su bucle, el relleno ve CERO filas —esta migración vacía app.current_tenant cuarenta líneas antes— mientras el SET NOT NULL escanea la tabla real y sí ve los NULL',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: 'CREATE INDEX idx_bank_tx_contenido',
        a: 'CREATE UNIQUE INDEX idx_bank_tx_contenido',
        porque: 'vuelve el invariante FALSO: dos retiros idénticos el mismo día son dos hechos ciertos, y con ON CONFLICT DO NOTHING el segundo se traga en silencio y se le acusa al banco',
      },
    ],
    evaluar: () => {
      // LA HUELLA Y SU RELLENO (T1, #88).
      //
      // La 003 declaraba `UNIQUE(bank_account_id, bank_transaction_id)` sobre
      // una columna NULLABLE, y en Postgres dos NULL no colisionan: reimportar
      // duplicaba el extracto entero. La 051 lo reparó donde no se puede
      // rodear —una huella que calcula la BASE—, pero se pasó de frenada en un
      // sitio y se quedó corta en tres.
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');

      // 1. LA CALCULA LA BASE, Y LA IMPONE. Una asignación directa, no un
      //    COALESCE que respetaría lo que venga de fuera.
      if (!/CREATE TRIGGER bank_transactions_content_hash/.test(sql)) {
        return falla('la huella dejó de calcularla la base: vuelve a depender de que cada superficie la mande bien');
      }
      if (!/NEW\.content_hash := encode\(/.test(sql)) {
        return falla('el disparador dejó de imponer la huella: si respeta la que manda el llamador, deja de identificar la línea');
      }
      // 2. Y LA IMPONE TAMBIÉN CONTRA QUIEN LA ESCRIBE. Sin `content_hash` en
      //    la lista vigilada, un UPDATE directo sobre la columna no dispara
      //    nada y la huella queda forjada. Medido antes de T1: escribir
      //    repeat('f',64) se quedaba escrito.
      const disparador = sql.slice(sql.indexOf('CREATE TRIGGER bank_transactions_content_hash'));
      if (!/UPDATE OF[^\n]*\bcontent_hash\b/.test(disparador.slice(0, 300))) {
        return falla('content_hash salió de la lista vigilada del disparador: la huella se puede forjar a mano, y la 058 y banking.md prometen por escrito que no');
      }
      if (!/ALTER COLUMN content_hash SET NOT NULL/.test(sql)) {
        return falla('content_hash volvió a admitir NULL, que es la forma exacta del defecto que se venía a reparar');
      }

      // 3. EL RELLENO ALCANZA LO YA IMPORTADO. Las dos mitades: que toque una
      //    columna VIGILADA (si toca content_hash no dispara nada) y que corra
      //    por INQUILINO (esta migración deja row_security=on con el contexto
      //    vacío, así que sin bucle el UPDATE afecta cero filas en silencio).
      //    Las dos juntas eran el issue #88, y ningún espejo las custodiaba.
      if (/UPDATE bank_transactions SET content_hash\s*=/.test(sql)) {
        return falla('el relleno volvió a escribir content_hash directamente: no está en el UPDATE OF del disparador, así que no dispara nada y el SET NOT NULL revienta con 23502 en todo despacho con un movimiento importado (#88)');
      }
      const relleno = sql.slice(sql.indexOf('$relleno$'), sql.indexOf('ALTER TABLE bank_transactions ALTER COLUMN content_hash'));
      if (!/SET LOCAL row_security = on;[\s\S]{0,200}\$relleno\$/.test(sql) || !/FOR t IN SELECT id FROM tenants/.test(relleno)) {
        return falla('el relleno perdió su opt-in de RLS o su bucle por inquilino: ve cero filas, y el SET NOT NULL las ve todas (#88)');
      }

      // 4. Y LA HUELLA NO ES UNA LLAVE. El hash se calcula sobre
      //    (cuenta|fecha|importe|descripción), que no distingue dos HECHOS
      //    distintos: dos retiros iguales el mismo día son dos retiros. Único,
      //    este índice declaraba irrepresentable un extracto real, impedía
      //    instalarse en el despacho que venía a reparar, y con el
      //    `ON CONFLICT DO NOTHING` de insertarLineas se tragaba en silencio la
      //    segunda comisión legítima acusando al banco de mandarla repetida.
      //    Lo que impide el reimporte es UNIQUE(bank_account_id, file_sha256).
      if (/CREATE UNIQUE INDEX \w*bank_tx_contenido/.test(sql)) {
        return falla('la huella volvió a ser llave única: declara irrepresentable un extracto con dos movimientos legítimamente iguales, y el importador se los traga en silencio');
      }
      return /UNIQUE\s*\(bank_account_id,\s*file_sha256\)/.test(sql)
        ? ok('la huella la impone la base contra cualquier escritor, el relleno la alcanza por inquilino, y quien impide el reimporte es la unicidad del ARCHIVO')
        : falla('desapareció la unicidad del archivo: sin ella nada impide reimportar el mismo extracto, que era el defecto original de la 051');
    },
  },

  {
    paquete: 'E0.3',
    id: 'statement-import-draft-only',
    enunciado: 'Importar un extracto no alcanza el mayor, que es lo único que se lo permite al agente',
    mutantes: [
      {
        // El mutante inserta CÓDIGO, no un comentario. La primera versión
        // metía `/* createJournalEntry( */` y sobrevivía con razón:
        // `codigoDe` quita los comentarios antes de mirar, y un comentario
        // que nombra el mayor no es un camino al mayor. El mutante estaba
        // mal, no el ancla.
        archivo: 'src/services/banking/bank-statement-service.ts',
        de: '    await client.query(',
        a: '    await createJournalEntry(); await client.query(',
        porque: 'basta un camino al mayor dentro del importador para que su `draftOnly` sea falso, y con él la única razón por la que el agente puede invocarlo',
      },
      {
        archivo: 'src/cli/bank-command.ts',
        de: '    draftOnly: true,',
        a: '    draftOnly: false,',
        porque: 'el agente conservaría la escritura sin la afirmación que la justifica — es la combinación que declareRisk existe para negar',
      },
    ],
    evaluar: () => {
      // `bank statement import` es la ÚNICA fila de esta familia con IA ✓
      // sobre un verbo que escribe, y `declareRisk` sólo lo admite con
      // `draftOnly: true` (kernel/risk.ts:103). Esa afirmación no se cree: se
      // comprueba. Lo que la sostiene es que el importador escribe staging
      // bancario —la afirmación de un tercero sobre nuestro dinero, esperando
      // cotejo— y no tiene camino al mayor por ninguna bandera.
      const cli = codigoDe('src/cli/bank-command.ts');
      const svc = codigoDe('src/services/banking/bank-statement-service.ts');

      const declara = /declareRisk\(importar, \{[\s\S]{0,200}?risk: 'escritura',[\s\S]{0,120}?agent: true,[\s\S]{0,120}?draftOnly: true,/.test(cli);
      if (!declara) {
        return falla('`bank statement import` dejó de declararse escritura+agente+draftOnly: o el agente perdió la fila, o la ganó sin la afirmación que la justifica');
      }

      // Y LA AFIRMACIÓN SE VERIFICA CONTRA EL SERVICIO. Un `draftOnly: true`
      // es una promesa sobre lo que el código hace; anclarlo sin mirar el
      // servicio sería creerle a la declaración.
      const alMayor = /createJournalEntry|postJournalEntry|INSERT INTO journal_entries/.exec(svc);
      return alMayor === null
        ? ok('el importador declara draftOnly y lo cumple: no hay un solo camino desde él al mayor')
        : falla(
            `el importador alcanza el mayor ("${alMayor[0]}"): su draftOnly es falso y con él la razón por la que el agente puede llamarlo`
          );
    },
  },

  {
    paquete: 'E0.3',
    id: 'clabe-encrypted-and-masked',
    enunciado: 'La CLABE se guarda cifrada, como el número de cuenta que es',
    mutantes: [
      {
        archivo: 'src/services/banking/bank-account-service.ts',
        de: '            clabe ? encrypt(clabe.clabe) : null,',
        a: '            clabe ? clabe.clabe : null,',
        porque: 'la CLABE vuelve a la base en claro, que es exactamente el defecto de la 003 que este tramo repara',
      },
    ],
    evaluar: () => {
      // La 003 cifraba el número de cuenta y el routing y dejaba la CLABE en
      // `VARCHAR(18)` a la vista, al lado de las otras dos. La CLABE ES el
      // número de cuenta en México: era el mismo dato que las columnas
      // vecinas protegían, guardado sin protección. El criterio E0.3 de la
      // bitácora ya la nombraba entre «los campos que los servicios cifran
      // hoy» — daba por hecho un cifrado que no existía.
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');
      if (!/ALTER TABLE bank_accounts DROP COLUMN clabe;/.test(sql)) {
        return falla('la columna clabe en claro sigue en pie');
      }
      const svc = codigoDe('src/services/banking/bank-account-service.ts');
      if (!/encrypt\(clabe\.clabe\)/.test(svc)) {
        return falla('la CLABE se escribe sin cifrar: vuelve a estar en claro en la base');
      }
      // Y NO SALE ENTERA POR NINGUNA SUPERFICIE: lo que se muestra son los
      // últimos cuatro. Cifrarla y luego imprimirla no protege nada.
      const enmascara = /clabe: enmascarar\(fila\.clabe_last4\)/.test(svc);
      return enmascara
        ? ok('la CLABE se cifra al escribir y sólo salen sus últimos cuatro dígitos al leer')
        : falla('la ficha de la cuenta dejó de enmascarar la CLABE: cifrarla y luego imprimirla no protege nada');
    },
  },

  // ---- F04 · Pagar ----

  {
    paquete: 'E0.3',
    id: 'new-supplier-requires-explicit-authorization',
    enunciado: 'Un CFDI de fuera no da de alta a su propio emisor: el alta de contraparte la autoriza quien llama',
    mutantes: [
      {
        archivo: 'src/services/xml-ingestion/pre-registration-service.ts',
        de: '} else if (!opciones.permitirProveedorNuevo) {',
        a: '} else if (false) {',
        porque: 'la puerta se abre de par en par: cualquier XML volvería a fabricar la contraparte y su pasivo sin que nadie lo apruebe',
      },
      {
        archivo: 'src/services/xml-ingestion/pre-registration-service.ts',
        de: 'await this.processToAccounting(preReg, userId, { permitirProveedorNuevo: false });',
        a: 'await this.processToAccounting(preReg, userId, { permitirProveedorNuevo: true });',
        porque: 'el lote programado —que corre desatendido sobre N documentos— se autoconcede crear proveedores: quien lanzó el lote aprobó el lote, no al emisor de cada comprobante',
      },
    ],
    evaluar: () => {
      // EL HUECO QUE EL PROPIO CATÁLOGO TENÍA ESCRITO. `createBillFromPreReg`
      // daba de alta al emisor del comprobante con el nombre y el RFC que
      // venían DENTRO del XML —dato maestro redactado por un tercero— y en la
      // misma llamada reconocía el pasivo a su favor y posteaba su póliza.
      // Bastaba con que un CFDI llegara, por cualquier vía, para que el
      // catálogo de proveedores creciera solo. Es el ejemplo de manual de por
      // qué un control interno existe.
      const svc = codigoDe('src/services/xml-ingestion/pre-registration-service.ts');

      // 1. La puerta existe y es FAIL-CLOSED: se ancla el throw, no el `if`.
      //    Un guardia que comprueba y no actúa es la fuga clásica.
      if (!/else if \(!opciones\.permitirProveedorNuevo\) \{[\s\S]{0,400}?throw new ProveedorNuevoSinAutorizar\(/.test(svc)) {
        return falla(
          'el alta del emisor del CFDI ya no exige autorización del llamador: un XML de fuera ' +
            'volvería a crear la contraparte y su pasivo sin que nadie lo apruebe'
        );
      }

      // 2. El defecto es NO. Una opción cuyo tipo admite `undefined` y que se
      //    lee sin `?? false` sería fail-open el día que alguien pase `{}`.
      if (!/permitirProveedorNuevo\?: boolean;/.test(svc)) {
        return falla('la autorización dejó de ser opcional-negativa: el que no dice nada tiene que NO crear proveedores');
      }

      // 3. NINGÚN camino automático la concede. Se listan por ruta y se exige
      //    que todos pasen `false` literal: el motor de reglas (que un renglón
      //    antes pudo ponerse processing_mode='auto' él mismo), el lote
      //    programado, la ingesta del agente y el barrido de REP pendientes.
      const AUTOMATICOS: Record<string, string> = {
        'src/ai/ingest-service.ts': 'la ingesta del agente',
        'src/services/xml-ingestion/rep-pendientes.ts': 'el barrido de REP pendientes',
      };
      const concedidos = Object.entries(AUTOMATICOS)
        .filter(([archivo]) => {
          const f = codigoDe(archivo);
          return (
            /processToAccounting\(/.test(f) &&
            !/permitirProveedorNuevo:\s*false/.test(f)
          );
        })
        .map(([, quien]) => quien);
      if (concedidos.length > 0) {
        return falla(
          `camino(s) automático(s) que contabilizan sin negar el alta de proveedor: ${concedidos.join(', ')}`
        );
      }

      // Y dentro del propio servicio, las DOS ramas desatendidas —la del motor
      // de reglas y la del lote programado— la niegan. Se CUENTAN: son gemelas
      // textuales, y un ancla de presencia se conforma con encontrar la otra.
      const negaciones = (svc.match(/permitirProveedorNuevo:\s*false/g) ?? []).length;
      return negaciones >= 2
        ? ok(
            'el alta del emisor exige autorización explícita del llamador, el defecto es negarla ' +
              'y ningún camino desatendido la concede'
          )
        : falla(
            `sólo ${negaciones} de las 2 ramas desatendidas del servicio niegan el alta de proveedor ` +
              '(el motor de reglas y el lote programado)'
          );
    },
  },
];
