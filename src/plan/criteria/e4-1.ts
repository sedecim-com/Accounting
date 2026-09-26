import * as fs from 'node:fs';
import {
  codigoDe,
  consumidoresDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  ok,
  rutaDe,
  sinProsa,
} from './shared.js';

// ============================================================
// THE E4.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E4_1: Criterio[] = [

  // ---- E4.1 · Ciclos de banca y nómina ----
  {
    paquete: 'E4.1',
    id: 'bank-reconciliation-posts-difference',
    enunciado: 'Una conciliación no se declara cuadrada sin postear su diferencia',
    evaluar: () => {
      const p = 'src/api/rest/routes/bank-reconciliation.ts';
      const s = codigoDe(p);
      const marca = /status\s*=\s*'balanced'/.test(s);
      const postea = /createJournalEntry|postJournalEntry/.test(s);
      if (!marca) return ok('ninguna ruta marca cuadrado sin más');
      return postea
        ? ok('marca cuadrado y postea')
        : falla('marca cuadrado sin postear, y la compuerta de cierre lo acepta como prueba');
    },
  },
  {
    paquete: 'E4.1',
    id: 'payroll-account-mapping-seeded',
    enunciado: 'El mapeo contable de nómina se siembra en el alta',
    evaluar: () => {
      const cons = consumidoresDe('seedPayrollAccountMapping', 'payroll-account-mapping-seed.ts');
      return cons.length > 0
        ? ok(`sembrado desde ${cons.join(', ')}`)
        : falla('payroll_account_mapping sin escritor: la primera corrida de nómina muere');
    },
  },

  {
    paquete: 'E4.1',
    id: 'payroll-output-tables-have-writers',
    enunciado: 'La nómina escribe los impuestos que sus formularios reportan',
    evaluar: () => {
      // ROJO HONESTO NUEVO. Los dos criterios anteriores de E4.1 miden la
      // conciliación y la siembra del mapeo — y con ellos en verde el paquete
      // entero figuraba cerrado mientras su salida no ocurre: paycheck_taxes,
      // employer_tax_liabilities y garnishments se LEEN (los formularios
      // 941/940, el posteo al mayor, el motor de embargos) y ningún camino
      // las escribe. El resultado es un número falso con aspecto de número:
      // los formularios reportan ceros y los embargos se descuentan de una
      // tabla que nadie puede poblar. `doctor` ya lo clasifica así; el
      // tablero tiene que decirlo también, porque es el que ordena sprints.
      const tablas = ['paycheck_taxes', 'employer_tax_liabilities', 'garnishments'];
      const sinEscritor = tablas.filter(
        (t) => dondeAparece(new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i'), ['src'], true).length === 0
      );
      return sinEscritor.length === 0
        ? ok('las tres tablas de la salida de nómina tienen escritor')
        : falla(
            `${sinEscritor.join(', ')}: se leen y nadie las escribe — los 941/940 reportan ` +
              'ceros y los embargos salen de una tabla que ningún camino puebla'
          );
    },
  },

  // ---------------------------------------------------------------
  // F08 · THE ORDER NOBODY COULD FILE (#113)
  //
  // The criterion above goes green on ONE live SQL literal under `src/` —
  // `dondeAparece` counts appearances, not paths — so a writer nobody calls
  // satisfies it. The four below are what that criterion cannot assert: that
  // the write is reachable, that it refuses when the CCPA caps are missing,
  // that its boundary is the ENTITY and not the tenant, and that archiving
  // really does stop the withholding.
  // ---------------------------------------------------------------
  {
    paquete: 'E4.1',
    id: 'garnishment-order-has-a-reachable-writer',
    enunciado: 'La orden de embargo tiene escritor, y el escritor tiene puerta',
    mutantes: [
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerGarnishmentCommand(program, { palette: c, shutdown, reportError });',
        // The call is DELETED, not commented out. `sinComentarios` is a
        // declared approximation and over this file it left the commented
        // line alive, so the mutant survived by measuring its own text. A
        // mirror that depends on the comment stripper getting it right does
        // not measure behaviour: it measures the stripper.
        a: 'void 0;',
        porque:
          'el escritor se queda de capacidad huérfana: el INSERT existe, typechecka y no lo alcanza ningún camino, que es exactamente el estado que este criterio existe para prohibir — y el criterio del literal seguiría verde',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '         employee_id, garnishment_type, priority, amount_type, amount_value,',
        a: '         employee_id, tenant_id, garnishment_type, priority, amount_type, amount_value,',
        porque:
          'el llamador vuelve a afirmar un hecho DERIVADO: el disparador de la 077 sobrescribe `tenant_id` con el del empleado, así que la columna en la lista no cambia lo guardado y sí publica una propiedad que el escritor no decide',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '         case_number, issuing_authority, payee_name, start_date, is_active, metadata',
        a: '         case_number, issuing_authority, payee_name, start_date, metadata',
        porque:
          '`is_active` es NULABLE y la 085 no la restringe a propósito, así que una orden dada de alta sin ella queda invisible para el motor —que filtra `is_active = true`— y retiene cero en silencio: el mismo cero que la 075 vino a cerrar',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '       SELECT e.id, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::jsonb',
        a: '       SELECT e.id, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10::jsonb',
        porque:
          'el defecto se mueve UN TOKEN a la derecha y produce exactamente la fila que el mutante anterior describe: la columna sigue nombrada y lo que se escribe en ella es NULL, así que la orden es invisible para el motor y retiene cero. La primera redacción de este criterio miraba la lista de NOMBRES y se quedaba verde ante esto',
      },
    ],
    evaluar: () => {
      const service = 'src/services/payroll/common/garnishment-service.ts';
      const leaf = 'src/cli/garnishment-command.ts';
      const root = 'src/cli/mnemosine.ts';
      for (const f of [service, leaf, root]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      // 1. THE INSERT, READ AS A STATEMENT: THE NAMES AND THE VALUES.
      //
      // Parsed and not grepped, because a column list is a LIST and the
      // question «is `is_active` written, and written TRUE» is positional:
      // the first draft asked only whether the name appeared, and moving the
      // defect one token right — `$9, NULL, $10::jsonb` — left it green while
      // the row it produced was the invisible one the mutant above describes.
      //
      // (The reason first written here for parsing instead of grepping was
      // that this statement's own WHERE carries `e.tenant_id`, so a file-wide
      // regex would redden correct code. That was false and is corrected:
      // `reciboEnEntidad` emits `e2.entity_id`, and the token `tenant_id`
      // does not occur once in this file's CODE. The real reason is the one
      // above — a parse answers a question a search cannot even ask.)
      const code = codigoDe(service);
      const at = code.indexOf('INSERT INTO garnishments (');
      if (at < 0) {
        return falla(
          'el servicio de embargos dejó de tener su INSERT: `garnishments` vuelve a ser una tabla que el recibo lee y que ningún camino puebla'
        );
      }
      const open = code.indexOf('(', at);
      const close = code.indexOf(')', open);
      const columns = code.slice(open + 1, close).split(',').map((c) => c.trim());

      if (columns.some((c) => c === 'tenant_id')) {
        return falla(
          'la lista de columnas del INSERT volvió a nombrar `tenant_id`: el disparador de la 077 lo sobrescribe con el del empleado, así que el escritor estaría afirmando una pertenencia que no determina'
        );
      }
      const activeAt = columns.indexOf('is_active');
      if (activeAt < 0) {
        return falla(
          'el INSERT dejó de escribir `is_active`: la columna es nulable y el motor filtra `is_active = true`, de modo que la orden existiría en la tabla y retendría cero sin que nada lo diga'
        );
      }

      const selectAt = code.indexOf('SELECT', close);
      const fromAt = code.indexOf('FROM employees e', selectAt);
      if (selectAt < 0 || fromAt < 0) {
        return falla('el INSERT dejó de alimentarse de un SELECT sobre `employees`: ya no se puede leer qué valor recibe cada columna');
      }
      const values = code.slice(selectAt + 'SELECT'.length, fromAt).split(',').map((v) => v.trim());
      if (values.length !== columns.length) {
        return falla(
          `el INSERT nombra ${columns.length} columnas y alimenta ${values.length} valores: uno de los dos lados se movió y la correspondencia dejó de poder comprobarse`
        );
      }
      if (values[activeAt] !== 'true') {
        return falla(
          `el INSERT escribe «${values[activeAt]}» en \`is_active\` en vez de \`true\`: la columna es nulable, el motor filtra \`is_active = true\`, y la orden quedaría en la tabla reteniendo cero en silencio`
        );
      }

      // 2. AND THE PATH THAT REACHES IT.
      const consumers = consumidoresDe('recordGarnishment', 'garnishment-service.ts');
      if (!consumers.includes(leaf)) {
        return falla(
          `nadie consume recordGarnishment fuera de su propio archivo (${consumers.join(', ') || 'ningún archivo'}): un escritor sin puerta es capacidad huérfana`
        );
      }
      if (!codigoDe(root).includes('registerGarnishmentCommand(program')) {
        return falla(
          'mnemosine.ts dejó de registrar la familia `garnishment`: la hoja existe y el binario no la publica, así que el escritor sigue sin ser alcanzable'
        );
      }

      return ok(
        'el INSERT vive en el servicio, no afirma el inquilino, escribe `is_active`, y la hoja que lo llama está registrada en el binario'
      );
    },
  },
  {
    paquete: 'E4.1',
    id: 'garnishment-order-refuses-without-its-ccpa-inputs',
    enunciado: 'Una orden sin los topes que el motor lee no se puede dar de alta, ni por el comando ni por SQL',
    mutantes: [
      {
        archivo: 'src/database/migrations/085_the_order_that_nobody_could_file.sql',
        // THE ANCHOR STARTS AT `OR (CASE` AND NOT AT `WHEN`, and that is not
        // cosmetic: the census applies the SAME predicate three spaces further
        // in, so an anchor beginning at `WHEN` matches INSIDE the census line
        // first — it is its prefix — and `String.replace` mutates that one.
        // Measured: with the short anchor this mutant SURVIVED, because what
        // it broke was the census while the constraint kept biting.
        de: `         OR (CASE
               WHEN COALESCE(metadata ->> 'exempt_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
               THEN (metadata ->> 'exempt_amount')::numeric > 0`,
        a: `         OR (CASE
               WHEN COALESCE(metadata ->> 'exempt_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
               THEN true`,
        porque:
          'la restricción vuelve a admitir una exención de CERO, y cero no es una exención pequeña: es el mismo resultado que no tener ninguna —`disponible - 0`, el cheque entero, `cap_applied` en null—. El censo de arriba sigue mirando el valor, así que sin leer la restricción por su nombre este mutante quedaba vivo',
      },
      {
        archivo: 'src/database/migrations/085_the_order_that_nobody_could_file.sql',
        de: `  ADD CONSTRAINT ck_garnishments_support_caps
  CHECK (garnishment_type <> 'child_support'
         OR (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'missing') = 'boolean'
             AND COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'missing') = 'boolean'));`,
        a: `  ADD CONSTRAINT ck_garnishments_support_caps
  CHECK (true);`,
        porque:
          'la restricción se vuelve decorativa y una orden de manutención sin sus dos respuestas vuelve a ser guardable: el motor lee la ausencia como «no», que es el tope de 60 % en vez del de 50 % — diez puntos del ingreso disponible de una persona',
      },
      {
        archivo: 'src/database/migrations/085_the_order_that_nobody_could_file.sql',
        de: `  ADD CONSTRAINT ck_garnishments_maintenance_caps
  CHECK (garnishment_type <> 'pension_alimenticia'
         OR (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'boolean') = 'boolean'
             AND COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'boolean') = 'boolean'));`,
        a: `  ADD CONSTRAINT ck_garnishments_maintenance_caps
  CHECK (true);`,
        porque:
          'una pensión alimenticia vuelve a poder guardar «yes» donde el motor hace `(metadata ->> …)::boolean`: no es una orden que retenga de más, es un 22P02 EN MITAD de una corrida de nómina — la corrida entera aborta por una orden',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '    if (input.exempt_amount === undefined) {',
        a: '    if (input.exempt_amount === null) {',
        porque:
          'una bandera ausente llega como `undefined` y no como `null`, así que la negativa deja de dispararse: el contador ya no recibe la frase que le dice que sin la exención se retiene el cheque entero, y sólo lo para el 23514 crudo del controlador',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '    if (new Decimal(exempt).lessThanOrEqualTo(0)) {',
        a: '    if (new Decimal(exempt).lessThan(0)) {',
        porque:
          '`--exempt-amount 0` vuelve a dar de alta el embargo que retiene el CIEN POR CIENTO del disponible, que es palabra por palabra el resultado que la frase de la negativa de al lado dice impedir: una valla cuya puerta produce el estado contra el que se levantó',
      },
    ],
    evaluar: () => {
      const migration = 'src/database/migrations/085_the_order_that_nobody_could_file.sql';
      const service = 'src/services/payroll/common/garnishment-service.ts';
      const proof = 'tests/integration/f08-the-order-nobody-could-file.int.spec.ts';
      for (const f of [migration, service]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      // 1. THE DATABASE, READ WITHOUT ITS PROSE AND CONSTRAINT BY CONSTRAINT.
      //
      // `sinProsa` and not bare `crudoDe`: this file's header explains why the
      // constraints test the VALUE and not the key, and a criterion that read
      // the comment would stay green with the constraint removed — the exact
      // failure `sinProsa` exists for.
      //
      // AND EACH CONSTRAINT IS CUT OUT BY NAME before it is read, which is the
      // second half of the same lesson. The census above the constraints
      // applies the SAME predicates — it has to, or the migration would abort
      // with a raw 23514 after absolving a row — so a file-wide `includes` has
      // two places to find every anchor, and a mutant that guts the CONSTRAINT
      // survives on the census's copy. An anchor repeated in a file disarms
      // its own mirror.
      const sql = sinProsa(crudoDe(migration));
      const constraintNamed = (name: string): string | null => {
        const at = sql.indexOf(`ADD CONSTRAINT ${name}`);
        if (at < 0) return null;
        const end = sql.indexOf(';', at);
        return end < 0 ? null : sql.slice(at, end);
      };

      const levy = constraintNamed('ck_garnishments_levy_exemption');
      if (!levy) return falla('la 085 dejó de instalar `ck_garnishments_levy_exemption`: el embargo fiscal sin exención vuelve a ser guardable por SQL');
      if (!levy.includes("COALESCE(metadata ->> 'exempt_amount', '') ~ '^[0-9]+([.][0-9]+)?$'")) {
        return falla(
          'la restricción de la exención dejó de comprobar el VALOR con su COALESCE: una llave ausente hace que la comparación valga NULL, y un CHECK que evalúa NULL se cumple — el embargo fiscal sin exención vuelve a ser guardable y retiene el cien por ciento del disponible'
        );
      }
      if (!levy.includes("(metadata ->> 'exempt_amount')::numeric > 0")) {
        return falla(
          'la restricción de la exención dejó de exigir que sea POSITIVA: una exención de cero no es una exención pequeña, es `disponible - 0` —el cheque entero— con `cap_applied` vacío, exactamente el mismo resultado que la llave ausente'
        );
      }

      const caps = constraintNamed('ck_garnishments_support_caps');
      if (!caps) return falla('la 085 dejó de instalar `ck_garnishments_support_caps`: una manutención sin sus dos respuestas vuelve a ser guardable');
      if (!caps.includes("garnishment_type <> 'child_support'")) {
        return falla(
          'la restricción de los topes dejó de apuntar a `child_support`: si ya no nombra el tipo que la CCPA gobierna, no está acotando a nadie'
        );
      }
      if (!caps.includes("COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'missing') = 'boolean'")) {
        return falla(
          'la 085 dejó de exigir que la segunda familia sea un booleano de verdad: una llave presente con valor nulo pasa, y el motor la lee como «no» — el tope salta de 50 % a 60 % del ingreso disponible'
        );
      }
      if (!caps.includes("COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'missing') = 'boolean'")) {
        return falla(
          'la 085 dejó de exigir que los atrasos de más de doce semanas sean un booleano: además de mover el tope cinco puntos, un valor que no sea booleano revienta con 22P02 DENTRO de una corrida de nómina'
        );
      }

      // THE MEXICAN ORDER IS NOT REQUIRED TO CARRY THE TWO CCPA ANSWERS —
      // the CCPA does not govern it and the cascade never runs for its
      // employee — but if it DOES carry them they must be booleans: a 22P02
      // does not care which country the order came from.
      const mx = constraintNamed('ck_garnishments_maintenance_caps');
      if (!mx || !mx.includes("garnishment_type <> 'pension_alimenticia'")) {
        return falla(
          'la 085 dejó de acotar el TIPO del valor en una pensión alimenticia: no se le exigen los dos topes —serían cifras inventadas sobre una orden que la CCPA no gobierna— pero un «yes» donde el motor hace `::boolean` aborta una corrida de nómina entera'
        );
      }
      if (!/ALTER COLUMN metadata SET NOT NULL/.test(sql)) {
        return falla(
          '`metadata` volvió a admitir NULL: la columna tendría dos valores vacíos distintos donde el motor lee lo mismo de los dos, y la 085 dejaría de poder afirmar que toda orden trae un objeto'
        );
      }

      // 2. AND THE TYPESCRIPT REFUSAL, WHICH IS THE ONE WITH WORDS.
      //
      // The constraint stops the row; what tells the accountant that «I
      // forgot» and «I declared zero» buy the same thing is the sentence, and
      // without it the error is a raw 23514 from the driver naming a
      // constraint.
      const code = codigoDe(service);
      const from = code.indexOf('export function resolveCcpaMetadata');
      if (from < 0) return falla('el servicio dejó de exportar resolveCcpaMetadata: la negativa no tiene dónde vivir');
      const body = code.slice(from, from + 2600);
      if (!body.includes('input.exempt_amount === undefined')) {
        return falla(
          'el servicio dejó de negarse ante un embargo fiscal sin --exempt-amount: la ausencia vuelve a viajar hasta el motor, que la lee como cero y retiene el ingreso disponible entero'
        );
      }
      if (!body.includes('new Decimal(exempt).lessThanOrEqualTo(0)')) {
        return falla(
          'el servicio dejó de negarse ante `--exempt-amount 0`: es el MISMO cheque entero que la ausencia, y la frase de la negativa de al lado dice impedirlo — una valla con puerta'
        );
      }
      if (!body.includes("requireYesNo(\n        '--supports-second-family'") ||
          !body.includes("requireYesNo(\n        '--arrears-12wk'")) {
        return falla(
          'una orden de manutención volvió a poder darse de alta sin responder EXPLÍCITAMENTE a los dos topes de la CCPA: un valor por omisión aquí es el tope equivocado escrito como comodidad'
        );
      }

      return existe(proof)
        ? ok('las tres restricciones miran el valor y no la llave, la exención tiene que ser positiva, `metadata` no admite NULL, el servicio se niega con la consecuencia dicha, y hay prueba que lo ejecuta contra la base')
        : falla('no hay prueba que EJERCITE las restricciones de la 085 contra Postgres: leer un CHECK no demuestra qué admite');
    },
  },
  {
    paquete: 'E4.1',
    id: 'garnishment-order-scoped-by-its-employee',
    enunciado: 'La frontera de una orden de embargo es la entidad de su empleado, dentro de la misma sentencia',
    mutantes: [
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: "        AND ${reciboEnEntidad('g.employee_id', 3)}",
        a: '        AND g.tenant_id = $3',
        porque:
          'la frontera degrada a INQUILINO —que es justo lo que `requireByIdInScope` emitiría sobre esta tabla desde que la 077 le puso `tenant_id`— y una sociedad hermana del mismo inquilino puede archivar la orden judicial de otra empresa: el eje que scope.ts dice que RLS no defiende',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: "        WHERE e.id = $1 AND ${reciboEnEntidad('e.id', 11)}",
        a: '        WHERE e.id = $1',
        porque:
          'la escritura se queda apoyada en la lectura previa: entre mirar y escribir hay una ventana, y el INSERT deja de llevar su propia frontera — que es la única que `condicionDeAlcance` considera frontera',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '  if (updated.rowCount === 0) {',
        a: '  if (false) {',
        porque:
          'invariante 3 exactamente: un UPDATE que toca cero filas y no se queja. Archivar la orden de otra entidad contestaría éxito sin haber detenido ninguna retención',
      },
    ],
    evaluar: () => {
      const service = 'src/services/payroll/common/garnishment-service.ts';
      if (!existe(service)) return falla(`desapareció ${service}`);
      const code = codigoDe(service);

      // WHAT MAY NOT APPEAR. `garnishments` has no `entity_id` and since 077
      // it does have a `tenant_id`, so the generic helper resolves to TENANT
      // over this table and compiles just as well.
      if (code.includes("requireByIdInScope('garnishments'") || code.includes("findByIdInScope('garnishments'")) {
        return falla(
          'el servicio volvió a acotar `garnishments` con el ayudante genérico: sobre esta tabla eso resuelve a `tenant_id = $2`, así que dos sociedades del mismo inquilino se alcanzan las órdenes judiciales'
        );
      }

      // WHAT MUST. The employee → entity path, inside every statement.
      const insert = code.indexOf('INSERT INTO garnishments (');
      if (insert < 0) return falla('el servicio de embargos dejó de tener su INSERT');
      if (!code.slice(insert, insert + 900).includes("reciboEnEntidad('e.id', 11)")) {
        return falla(
          'el INSERT dejó de llevar el camino a la entidad DENTRO de su propio SQL: comprobar con un SELECT y escribir después reabre la ventana entre mirar y escribir'
        );
      }

      const archive = code.indexOf('export async function archiveGarnishment');
      if (archive < 0) return falla('el servicio dejó de exportar archiveGarnishment');
      const body = code.slice(archive, archive + 3000);
      if (!body.includes("reciboEnEntidad('g.employee_id', 3)")) {
        return falla(
          'el UPDATE de archivo dejó de llevar el camino a la entidad en la misma sentencia: se archiva la orden de la sociedad hermana'
        );
      }
      if (!body.includes('updated.rowCount === 0')) {
        return falla(
          'el archivo dejó de comprobar cuántas filas tocó: un UPDATE de cero filas que contesta éxito es la forma más limpia de no detener una retención y decir que sí'
        );
      }

      const list = code.indexOf('export async function listGarnishments');
      if (list < 0 || !code.slice(list, list + 1800).includes("reciboEnEntidad('g.employee_id', 1)")) {
        return falla(
          'la lectura de órdenes dejó de acotar por la entidad del empleado: se enumeran las órdenes judiciales de la sociedad hermana'
        );
      }

      return ok(
        'las tres hojas toman la frontera por `employees.entity_id` dentro de su propia sentencia, ninguna pasa por el ayudante genérico, y el archivo cuenta las filas que tocó'
      );
    },
  },
  {
    paquete: 'E4.1',
    id: 'garnishment-stops-by-is-active-not-by-a-date',
    enunciado: 'Archivar una orden detiene la retención, y lo que la detiene es `is_active`',
    mutantes: [
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: `        SET is_active = false,
            end_date = COALESCE($2::date, g.end_date)`,
        a: '        SET end_date = COALESCE($2::date, g.end_date)',
        porque:
          'la orden sigue reteniendo para siempre: ninguna consulta de `src/` DECIDE nada por `end_date` —el WHERE del motor no mira fechas; los únicos lectores que esa columna tiene la imprimen— así que un archivo que sólo escribe la fecha archiva en el papel y no en el dinero',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: `      WHERE g.id = $1
        AND g.is_active IS NOT FALSE`,
        a: '      WHERE g.id = $1',
        porque:
          'sin predicado de estado, archivar una orden YA archivada contesta éxito sobre una retención que nadie detuvo en ese momento, y el registro de cuándo se detuvo se sobrescribe con la fecha equivocada',
      },
      {
        archivo: 'src/services/payroll/common/garnishment-service.ts',
        de: '        AND g.is_active IS NOT FALSE',
        a: '        AND g.is_active',
        porque:
          'vuelve el callejón sin salida que la 085 deja abierto a propósito: una fila con `is_active` en NULL —que la 085 conserva porque adivinar qué significaba no es seguro— no casa con este predicado, así que no se puede archivar, y la negativa le dice al operador que «dejó de retener cuando se apagó la bandera», por un apagado que nunca ocurrió',
      },
      {
        archivo: 'src/services/payroll/usa/garnishments/garnishment-engine.ts',
        de: 'WHERE employee_id = $1 AND is_active = true',
        a: 'WHERE employee_id = $1 AND is_active IS NOT FALSE',
        porque:
          'las filas con `is_active` en NULL pasan a estar vivas, y entonces el `is_active` explícito del escritor deja de sostener nada: las dos mitades del trato —quien escribe y quien filtra— se separan sin que ninguna prueba de una sola de ellas se entere',
      },
    ],
    evaluar: () => {
      const service = 'src/services/payroll/common/garnishment-service.ts';
      const engine = 'src/services/payroll/usa/garnishments/garnishment-engine.ts';
      const proof = 'tests/integration/f08-the-order-nobody-could-file.int.spec.ts';
      for (const f of [service, engine]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      const code = codigoDe(service);
      const at = code.indexOf('export async function archiveGarnishment');
      if (at < 0) return falla('el servicio dejó de exportar archiveGarnishment');
      const body = code.slice(at, at + 3000);

      if (!body.includes('SET is_active = false')) {
        return falla(
          'archivar dejó de apagar `is_active`: la fila del catálogo promete que «detiene la retención» y `end_date` no lo hace — ninguna consulta de `src/` decide nada por esa columna'
        );
      }
      // `IS NOT FALSE` AND NOT A BARE `AND g.is_active`: one word of
      // difference and a whole state. 085 deliberately leaves `is_active`
      // nullable, and under the strict predicate those rows can NEVER be
      // archived — while the refusal calls them «already archived» for a
      // clearing that never happened. The state predicate is still there;
      // what moves is where it draws the line.
      if (!body.includes('AND g.is_active IS NOT FALSE')) {
        return falla(
          'el UPDATE de archivo perdió su predicado de estado, o volvió a exigir `is_active` estrictamente cierto: lo primero contesta éxito por una detención que ocurrió otro día; lo segundo deja sin salida a las filas que la 085 conserva con la bandera en NULL'
        );
      }

      // AND THE OTHER HALF OF THE BARGAIN. If the engine stops filtering on
      // the same value, clearing it stops nothing and nobody finds out.
      if (!codigoDe(engine).includes('is_active = true')) {
        return falla(
          'el motor dejó de filtrar `is_active = true`: apagar la bandera deja de detener la retención, y las dos mitades del trato se separaron sin que ninguna prueba de una sola de ellas lo vea'
        );
      }

      return existe(proof)
        ? ok('archivar apaga `is_active` con predicado de estado, el motor sigue filtrando por ese mismo valor, y hay prueba que retiene primero y deja de retener después contra la base')
        : falla('no hay prueba que MIDA la retención antes y después de archivar: leer el UPDATE no demuestra que el dinero dejó de salir');
    },
  },

  // ---------------------------------------------------------------
  // A6 · EL CONDUCTOR DEL CIERRE Y SU EXPEDIENTE
  //
  // La tarjeta de A6 nace con su prueba de aceptación puesta: «el expediente
  // que entrega tiene que poder volver a correrse por un tercero y dar las
  // mismas cifras». Los cuatro criterios de aquí abajo vigilan las maneras
  // REALES de romper esa frase —o el cierre que la precede— sin que nada se
  // ponga rojo. La primera versión de estos criterios la sometió una revisión
  // adversaria, que encontró que casi todos se podían dejar verdes con la
  // conducta rota: anclas de presencia que no miraban el orden, una delegación
  // que casaba con la llamada del ensayo, un filtro de posteado que se podía
  // comentar dentro del SQL. Lo que sigue es lo que sobrevivió a esa lectura.
  // ---------------------------------------------------------------
  {
    paquete: 'E4.1',
    id: 'closing-dossier-seals-the-books-not-the-clock',
    enunciado:
      'El expediente del cierre sella la fecha del periodo, nunca el reloj: por eso un tercero puede volver a correrlo',
    evaluar: () => {
      const p = 'src/services/accounting/closing-pack.ts';
      if (!existe(p)) return falla(`no existe ${p}: el expediente de A6 desapareció`);
      // `sinProsa` además de `codigoDe`: el segundo salta los literales de
      // plantilla —ahí vive el SQL— y el primero quita las líneas que el SQL
      // comenta con `--`, que de otro modo seguirían «presentes».
      const s = sinProsa(codigoDe(p));

      const section = (from: string, to: string): string | null => {
        const i = s.indexOf(from);
        const j = s.indexOf(to, i + from.length);
        return i < 0 || j < 0 ? null : s.slice(i, j);
      };

      // La derivación se lee ACOTADA: `buildClosingPack` SÍ tiene un reloj —el
      // sobre lleva `generated_at`— y buscarlo en todo el fuente pondría en
      // rojo la única línea que debe tenerlo.
      const derivation = section('export async function deriveSealedBody', 'export interface BuildPackOptions');
      if (!derivation) {
        return falla(
          'no se encuentra `deriveSealedBody` acotada por `BuildPackOptions`: la derivación se ' +
            'renombró o se movió, y este criterio dejaría de mirar lo que vino a mirar'
        );
      }

      if (!/const asOf = period\.end_date;/.test(derivation)) {
        return falla(
          'la fecha de corte del expediente ya no sale del periodo: si sale de otro sitio, dos ' +
            'derivaciones del mismo mes pueden dar cifras distintas y la comprobación no prueba nada'
        );
      }

      // Las fuentes de reloj que Postgres y JavaScript ofrecen, no sólo las dos
      // obvias: la revisión adversaria encontró que `Date.now()`,
      // `CURRENT_TIMESTAMP` o `clock_timestamp()` pasaban por la versión corta.
      const CLOCK =
        /new Date\b|\bDate\(\)|Date\.now\(|performance\.now|hrtime|Temporal\.Now|CURRENT_(?:DATE|TIME|TIMESTAMP)|LOCALTIME|\bNOW\(\)|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|'(?:now|today|tomorrow|yesterday)'/i;
      const clock = CLOCK.exec(derivation);
      if (clock) {
        return falla(
          `la derivación del cuerpo sellado consulta el reloj ("${clock[0]}"): el expediente ` +
            'verificaría hoy y derivaría mañana, en silencio'
        );
      }

      // Y el cuerpo que se sella es EL DERIVADO, sin retoques. Buscar las formas
      // de retocarlo (`sealed.x =`, un spread) resultó una lista que nunca se
      // acaba —la segunda revisión pasó `Object.assign(sealed, …)`,
      // `sealed['as_of'] =`, `delete sealed.criteria` y un alias—, así que se
      // CUENTA: en `buildClosingPack` el nombre `sealed` aparece exactamente
      // tres veces —la declaración, la propiedad y el sello—. Cualquier otro
      // uso es un retoque, se escriba como se escriba.
      const builder = section('export async function buildClosingPack', 'export async function storeClosingPack');
      if (!builder) return falla('no se encuentra `buildClosingPack` acotada por `storeClosingPack`');
      if (!/const sealed = await deriveSealedBody\(entityId, periodId\);/.test(builder)) {
        return falla('el cuerpo sellado ya no es el que devuelve la derivación compartida');
      }
      if (!/\n\s*sealed,\n/.test(builder) || !/seal: sealOf\(sealed\)/.test(builder)) {
        return falla('el expediente ya no lleva y sella el cuerpo derivado tal cual');
      }
      const uses = (builder.match(/\bsealed\b/g) ?? []).length;
      if (uses !== 3) {
        return falla(
          `el cuerpo sellado se usa ${uses} veces en buildClosingPack y debe usarse 3 (declararlo, ` +
            'llevarlo y sellarlo): cualquier otro uso lo retoca o lo pasa por otro nombre antes del sello'
        );
      }
      // Y el reloj del sobre es el ÚNICO de la construcción: se quita esa línea
      // y el resto se somete a la misma lista de relojes.
      const withoutEnvelopeClock = builder.replace(
        'generated_at: (opts.now ?? new Date()).toISOString(),',
        ''
      );
      const builderClock = CLOCK.exec(withoutEnvelopeClock);
      if (builderClock) {
        return falla(
          `buildClosingPack consulta el reloj fuera del sobre ("${builderClock[0]}"): si llega al cuerpo, ` +
            'el sello deja de ser reproducible'
        );
      }

      return ok(
        'el corte es la fecha del periodo, la derivación no consulta ningún reloj, y lo sellado es ' +
          'el cuerpo derivado sin retoques'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '  const asOf = period.end_date;',
        a: '  const asOf = new Date().toISOString().slice(0, 10);',
        porque:
          'el corte pasa a ser el reloj: el expediente verifica el día que se sella y deriva el ' +
          'siguiente, que es la manera silenciosa de que «las mismas cifras» deje de ser cierto',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '  const asOf = period.end_date;\n',
        a: '  const asOf = period.end_date;\n  const now = Date.now();\n',
        porque:
          'el reloj entra en la derivación por la puerta de al lado, con el ancla intacta: un ' +
          'criterio que sólo comprobara la línea del corte lo dejaría pasar',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: 'start_date::text, end_date::text, status',
        a: 'start_date::text, CURRENT_DATE::text AS end_date, status',
        porque:
          'el reloj entra por el SQL y no por JavaScript: el corte sigue saliendo de «el periodo», ' +
          'pero el periodo ya dice hoy',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '  const sealed = await deriveSealedBody(entityId, periodId);\n',
        a: "  const sealed = await deriveSealedBody(entityId, periodId);\n  Object.assign(sealed, { as_of: '2026-12-31' });\n",
        porque:
          'el cuerpo se retoca con Object.assign y sin reloj: la forma que la lista de patrones de la ' +
          'versión anterior no veía',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '  const sealed = await deriveSealedBody(entityId, periodId);\n',
        a: '  const sealed = await deriveSealedBody(entityId, periodId);\n  sealed.as_of = new Date().toISOString();\n',
        porque:
          'el reloj se cuela en el cuerpo YA derivado, dentro de buildClosingPack: el sello lo ' +
          'incluye y ningún tercero vuelve a obtenerlo',
      },
    ],
  },
  {
    paquete: 'E4.1',
    id: 'closing-dossier-reads-the-posted-ledger-in-order',
    enunciado:
      'Las cifras del expediente salen del mayor posteado, acotadas al corte y en orden fijo',
    evaluar: () => {
      const p = 'src/services/accounting/closing-pack.ts';
      if (!existe(p)) return falla(`no existe ${p}: el expediente de A6 desapareció`);
      const s = sinProsa(codigoDe(p));

      // UNA SOLA BALANZA, ACOTADA AL CORTE. Un segundo motor sería el mismo
      // defecto que G4 persigue en la API; una balanza sin corte crece con
      // cada mes que pasa y ningún expediente viejo se sostiene.
      // Y EN CRUDO: la balanza de los libros, no la de un informe. El panel
      // decide qué MUESTRA un informe publicado; sellado bajo un panel y
      // comprobado bajo otro, el expediente acusaría cifras movidas sin que se
      // moviera un asiento. La segunda revisión lo mostró con
      // `informes_asientos_de_cierre`: sellar el valor del panel no bastaba,
      // porque la comprobación volvía a derivar bajo el panel de hoy.
      if (!/queryTrialBalanceRows\(entityId, \{ asOfDate: asOf, ignoreClosingPolicy: true \}\)/.test(s)) {
        return falla(
          'el expediente ya no pide al motor compartido la balanza EN CRUDO con el corte del periodo: ' +
            'o se armó otra balanza, o perdió el corte, o volvió a obedecer al panel de informes'
        );
      }
      // EL FILTRO DE POSTEADO, LEÍDO EN EL SQL Y SIN SUS COMENTARIOS. La versión
      // anterior buscaba el texto en todo el archivo y sólo sabía de un `--` a
      // principio de línea: un `/* … */`, un `--` a media línea o un `OR TRUE`
      // lo dejaban verde con los borradores dentro. Ahora se toma la plantilla
      // de la consulta de actividad, se le quitan los comentarios de SQL, y su
      // WHERE tiene que exigir posteado y no tener ningún OR.
      const activitySql = (() => {
        const i = s.indexOf('const activity = await query<');
        const a = s.indexOf('`', i);
        const b = s.indexOf('`', a + 1);
        return i < 0 || a < 0 || b < 0 ? '' : s.slice(a + 1, b);
      })();
      const bareSql = activitySql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
      const where = /\bWHERE\b([\s\S]*?)\bGROUP BY\b/i.exec(bareSql)?.[1] ?? '';
      if (!/\bAND\s+je\.status\s*=\s*'posted'/i.test(where) || /\bOR\b/i.test(where)) {
        return falla(
          'la actividad del periodo dejó de exigir posteado en su WHERE —quitado, comentado o ' +
            'neutralizado con OR—: un expediente que cuenta borradores se mueve cada vez que alguien edita uno'
        );
      }

      // EL ORDEN LO FIJA EL EXPEDIENTE, NO LA BASE. Un ORDER BY deja el orden
      // a la intercalación de Postgres, que puede no ser la misma en la
      // máquina que sella y en la que comprueba.
      if (!/const byCodeUnit = \(a: string, b: string\): number => \(a < b \? -1 : a > b \? 1 : 0\);/.test(s)) {
        return falla(
          'el comparador del expediente dejó de ser por unidad de código: con `localeCompare` o ' +
            'con la intercalación de la base, dos máquinas ordenan —y sellan— distinto'
        );
      }
      for (const [key, what] of [
        ['account_code', 'la balanza'],
        ['source_type', 'la actividad del periodo'],
      ] as const) {
        const ordering = new RegExp(`\\.sort\\(\\(a, b\\) => byCodeUnit\\(a\\.${key}, b\\.${key}\\)\\)`);
        if (!ordering.test(s)) {
          return falla(`${what} se sella sin ordenarse por ${key} en el propio expediente`);
        }
      }

      // UNA CUENTA QUE NUNCA SE MOVIÓ NO ES UNA CIFRA DEL MES. Sin este filtro,
      // dar de alta en septiembre una subcuenta vacía rompía todos los
      // expedientes anteriores.
      if (!/\.filter\(\(f\) => !new Decimal\(f\.debit\)\.isZero\(\) \|\| !new Decimal\(f\.credit\)\.isZero\(\)\)/.test(s)) {
        return falla(
          'la balanza sellada vuelve a incluir cuentas sin movimiento: el alta de una cuenta vacía ' +
            'rompería todo expediente anterior'
        );
      }

      // Y SE COMPARA POR CÓDIGO, NO POR POSICIÓN: por posición, una fila de
      // más desplazaba la culpa a todas las cuentas de después.
      const keyed = /new Map\(rows\.map\(\(r\) => \[String\(\(r as Record<string, unknown>\)\[key\]\), r\]\)\)/.test(s);
      if (!keyed || !/'account_code',\s*'figures\.trial_balance'/.test(s) || !/'source_type',\s*'figures\.period_activity'/.test(s)) {
        return falla(
          'la comprobación dejó de comparar la balanza por código o la actividad por origen: ' +
            'una fila de más acusaría a todas las que la siguen'
        );
      }

      if (!/const SCALE = 4;/.test(s) || !/new Decimal\(v \?\? 0\)\.toFixed\(SCALE\)/.test(s)) {
        return falla(
          'las cifras del expediente dejaron de normalizarse con Decimal a cuatro decimales: dos ' +
            'formatos del mismo importe sellan distinto'
        );
      }

      return ok(
        'balanza compartida en crudo al corte, sólo lo posteado, orden por unidad de código fijado en ' +
          'el expediente, sin cuentas vacías, comparada por código y a cuatro decimales'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: "        AND je.status = 'posted'\n",
        a: '',
        porque:
          'el expediente empieza a contar borradores: sus cifras se mueven cada vez que alguien ' +
          'edita uno',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: "        AND je.status = 'posted'\n",
        a: "        -- AND je.status = 'posted'\n",
        porque:
          'el filtro queda COMENTADO dentro del SQL: el texto sigue en el literal de plantilla, ' +
          'que `codigoDe` no toca',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: "        AND je.status = 'posted'\n",
        a: "        /* AND je.status = 'posted' */\n",
        porque: 'el filtro queda dentro de un comentario de bloque de SQL, que un ancla de texto sigue viendo',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: "        AND je.status = 'posted'\n",
        a: "        AND je.status = 'posted' OR TRUE\n",
        porque: 'el filtro sigue escrito y ya no filtra: OR TRUE deja entrar los borradores',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: 'queryTrialBalanceRows(entityId, { asOfDate: asOf, ignoreClosingPolicy: true })',
        a: 'queryTrialBalanceRows(entityId, { asOfDate: asOf })',
        porque:
          'la balanza vuelve a obedecer al panel de informes: cambiar informes_asientos_de_cierre ' +
          'después de sellar mueve cifras que el mayor no movió',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: 'queryTrialBalanceRows(entityId, { asOfDate: asOf, ignoreClosingPolicy: true })',
        a: 'queryTrialBalanceRows(entityId, { ignoreClosingPolicy: true })',
        porque:
          'la balanza pierde su corte y pasa a ser acumulada hasta hoy: el expediente de julio ' +
          'cambia en agosto sin que nadie toque julio',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: 'const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);',
        a: 'const byCodeUnit = (a: string, b: string): number => a.localeCompare(b);',
        porque:
          'el orden pasa a depender de la configuración regional de la máquina: el tercero ordena ' +
          'distinto y el sello no coincide sin que nada haya cambiado en los libros',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '    .sort((a, b) => byCodeUnit(a.account_code, b.account_code));',
        a: ';',
        porque: 'la balanza se sella en el orden que la base decida devolver',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: '    .filter((f) => !new Decimal(f.debit).isZero() || !new Decimal(f.credit).isZero())\n',
        a: '',
        porque:
          'las cuentas vacías vuelven al sello: dar de alta una subcuenta en septiembre rompe el ' +
          'expediente de julio',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: "'account_code',\n    'figures.trial_balance'",
        a: "'account_name',\n    'figures.trial_balance'",
        porque:
          'la balanza se compara por un campo que no la identifica: un renombre se reporta como ' +
          'una cuenta que desapareció y otra que apareció',
      },
      {
        archivo: 'src/services/accounting/closing-pack.ts',
        de: 'const SCALE = 4;',
        a: 'const SCALE = 2;',
        porque: 'el expediente redondea a centavos: una diferencia de 0.0040 deja de existir en el sello',
      },
    ],
  },
  {
    paquete: 'E4.1',
    id: 'closing-conductor-delegates-and-keeps-the-order',
    enunciado:
      'El conductor del cierre ordena y delega: no calcula ni una cifra, y su orden es el único posible',
    evaluar: () => {
      const p = 'src/services/accounting/closing-conductor.ts';
      if (!existe(p)) return falla(`no existe ${p}: el conductor de A6 desapareció`);
      const s = codigoDe(p);

      const section = (from: string, to: string): string | null => {
        const i = s.indexOf(from);
        const j = s.indexOf(to, i + from.length);
        return i < 0 || j < 0 ? null : s.slice(i, j);
      };

      const i = s.indexOf('export const CLOSING_STEPS = [');
      const j = s.indexOf('] as const', i);
      if (i < 0 || j <= i) return falla('no se encuentra la lista de pasos del conductor');
      const steps = [...s.slice(i, j).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

      // EL ORDEN. Los motores postean antes del checklist para que el
      // checklist juzgue el mes COMO SE VA A CERRAR —su balanza y su
      // integridad del mayor leen los asientos recién posteados—, y el
      // checklist va antes del cierre suave porque es el acto que su veredicto
      // autoriza. (Una versión anterior de este comentario decía que el
      // checklist BLOQUEABA sin la depreciación; no es así: esa casilla es una
      // advertencia.)
      const expected = [
        'accrue-benefits',
        'amortize-prepaids',
        'depreciate-assets',
        'verify-checklist',
        'soft-close',
      ];
      if (steps.join(',') !== expected.join(',')) {
        return falla(
          `los pasos del conductor son [${steps.join(', ')}] y tienen que ser ` +
            `[${expected.join(', ')}]: los motores antes del checklist, para que su veredicto ` +
            'describa el mes que se cierra, y el checklist antes del cierre que autoriza'
        );
      }

      // Y CADA PASO DELEGA, dentro de `takeStep` y no en cualquier parte del
      // archivo: la llamada del ensayo a `getCloseReadiness` hacía verde esta
      // comprobación aunque el paso real se inventara su veredicto.
      const realStep = section('async function takeStep(', 'function stepFailed(');
      if (!realStep) return falla('no se encuentra `takeStep` acotada por `stepFailed`');
      // EL CHECKLIST, EN SU RAMA Y USADO. No basta con que la llamada esté en
      // `takeStep`: tiene que ser lo que devuelve la rama `verify-checklist`, y
      // `checklistOutcome` tiene que decidir por `canClose`. La segunda revisión
      // dejó la llamada y descartó su resultado, o la movió de rama.
      if (!/case 'verify-checklist': \{[^}]*?return checklistOutcome\(step, ordinal, await getCloseReadiness\(ctx, period\)\);/.test(realStep)) {
        return falla('la rama verify-checklist ya no devuelve el veredicto de getCloseReadiness');
      }
      const judge = section('function checklistOutcome(', 'async function takeStep(');
      if (!judge || !/status: r\.canClose \? 'done' : 'blocked',/.test(judge)) {
        return falla('checklistOutcome dejó de decidir el estado del paso por canClose');
      }
      const engines = [
        'await runMonthlyProvisions(ctx.entityId, period.id, opts.userId)',
        'await runMonthlyAmortization(ctx.entityId, period.id, opts.userId)',
        'await runMonthlyDepreciation(ctx.entityId, period.id, opts.userId)',
        'await getCloseReadiness(ctx, period)',
        'await softClosePeriod(period.id, ctx.entityId, opts.userId, opts.reason)',
      ];
      const missing = engines.filter((m) => !realStep.includes(m));
      if (missing.length > 0) {
        return falla(
          `el paso real del conductor dejó de llamar a ${missing.join(', ')}: un paso que no ` +
            'delega es un motor nuevo'
        );
      }

      // CADA INTENTO CORRE CADA PASO. Un intento que se saltara lo que otro
      // intento anotó cerraría sobre un veredicto viejo —el borrador de IA que
      // llegó esta mañana— y dejaría sin devengar la nómina cargada después.
      const conductor = section('export async function conductClose(', 'async function dryRun(');
      if (!conductor) return falla('no se encuentra `conductClose` acotada por `dryRun`');
      // SIN CONDICIÓN: el cuerpo del bucle declara el resultado e inmediatamente
      // lo pide a `takeStep`. Un `if` delante —que desviara el checklist por otro
      // camino— rompe esta forma.
      if (!/let outcome: ClosingStepOutcome;\s*try \{\s*outcome = await takeStep\(ctx, period, step, ordinal, opts\);/.test(conductor)) {
        return falla('`conductClose` dejó de pasar cada paso, sin condición, por `takeStep`');
      }
      if (!/for \(const \[i, step\] of CLOSING_STEPS\.entries\(\)\) \{/.test(conductor)) {
        return falla('`conductClose` dejó de recorrer la lista entera de pasos');
      }
      // El registro de intentos anteriores sólo ETIQUETA: se lee una vez y se
      // usa una vez, para `priorAttempt`. Cualquier otro uso decide con él.
      if ((conductor.match(/\bpriorSteps\b/g) ?? []).length !== 2) {
        return falla(
          '`conductClose` usa lo que otro intento anotó para algo más que etiquetar: así es como una ' +
            'reanudación vuelve a fiarse de un veredicto viejo'
        );
      }
      if (/\bcontinue\b/.test(conductor)) {
        return falla(
          '`conductClose` salta pasos: un intento que no vuelve a correr lo que otro anotó cierra ' +
            'sobre un veredicto viejo'
        );
      }

      const arithmetic =
        /\bDecimal\b|debit_amount|credit_amount|\.plus\(|\.minus\(|\.times\(|parseFloat\(|toFixed\(/.exec(s);
      if (arithmetic) {
        return falla(
          `el conductor manipula importes en TypeScript ("${arithmetic[0]}"): no calcula cifras de ` +
            'los libros; lo único que suma es, en SQL y en su propio registro, lo que sus motores reportaron'
        );
      }

      return ok(
        `los cinco pasos en su orden (${steps.join(' → ')}), cada uno delegando dentro de takeStep, ` +
          'todos corridos en cada intento, y sin calcular ninguna cifra de los libros'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de:
          "  'accrue-benefits',\n  'amortize-prepaids',\n  'depreciate-assets',\n  'verify-checklist',",
        a:
          "  'verify-checklist',\n  'accrue-benefits',\n  'amortize-prepaids',\n  'depreciate-assets',",
        porque:
          'el checklist pasa a correr ANTES de los motores: su veredicto describe un mes al que ' +
          'todavía le faltan los asientos de ajuste que se van a postear',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      const r = await runMonthlyDepreciation(ctx.entityId, period.id, opts.userId);',
        a: '      const r = { processed: 0, errors: [] as string[] };',
        porque:
          'el conductor deja de delegar y se inventa el resultado del paso: el mes sale «conducido» ' +
          'con la depreciación sin correr',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      return checklistOutcome(step, ordinal, await getCloseReadiness(ctx, period));',
        a: '      return checklistOutcome(step, ordinal, { canClose: true, checklist: [], warnings: [], blockingIssues: [] } as never);',
        porque:
          'el paso real se inventa un veredicto limpio mientras el ensayo sigue preguntando de ' +
          'verdad: la versión anterior del criterio no distinguía las dos llamadas',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "    status: r.canClose ? 'done' : 'blocked',",
        a: "    status: 'done',",
        porque:
          'el juez del checklist ignora canClose: la llamada sigue ahí, en su rama, y todo sale limpio',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      return checklistOutcome(step, ordinal, await getCloseReadiness(ctx, period));',
        a: '      await getCloseReadiness(ctx, period);\n      return checklistOutcome(step, ordinal, { canClose: true, checklist: [], warnings: [], blockingIssues: [] } as never);',
        porque: 'la llamada se conserva y su resultado se tira: una ancla de presencia la daba por buena',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      let outcome: ClosingStepOutcome;\n',
        a: '      if (priorSteps.has(step)) continue;\n      let outcome: ClosingStepOutcome;\n',
        porque:
          'la reanudación vuelve a fiarse de lo anotado: el checklist de ayer autoriza el cierre de ' +
          'hoy con un borrador de IA pendiente dentro del mes',
      },
    ],
  },
  {
    paquete: 'E4.1',
    id: 'closing-run-never-continues-another-run-in-silence',
    enunciado:
      'La corrida abierta de un periodo no se continúa sin pedirlo: `closing run` se niega y dice dónde se detuvo',
    evaluar: () => {
      const conductorPath = 'src/services/accounting/closing-conductor.ts';
      const leafPath = 'src/cli/closing-command.ts';
      if (!existe(conductorPath) || !existe(leafPath)) return falla('el conductor o su hoja desaparecieron');
      const m = codigoDe(conductorPath);
      const h = codigoDe(leafPath);

      // LA REGLA VIVE EN EL CONDUCTOR, BAJO EL CANDADO. La comprobación de la
      // hoja llega antes de la confirmación y es cortesía; entre las dos, otro
      // operador podía abrir la corrida, y la versión anterior sólo miraba que
      // la cortesía estuviera escrita.
      const i = m.indexOf('async function openRun(');
      const j = m.indexOf('async function stepsOfRun(', i);
      if (i < 0 || j < 0) return falla('no se encuentra `openRun` en el conductor');
      const openRunBody = m.slice(i, j);
      // LA NEGATIVA ES LO PRIMERO del bloque de la corrida abierta: nada —ni
      // reabrirla, ni borrarle dónde se detuvo— ocurre antes. La versión que
      // comparaba posiciones de un ancla se desarmaba reescribiendo el UPDATE.
      if (!/if \(openRunRow\) \{\s*if \(opts\.resume !== true\) \{\s*throw new ClosingRunStateError\(\s*'CLOSING_RUN_OPEN'/.test(openRunBody)) {
        return falla(
          'el conductor dejó de negarse a continuar una corrida abierta que nadie pidió continuar'
        );
      }
      if (!/if \(opts\.resume === true\) \{\s*throw new ClosingRunStateError\(\s*'CLOSING_RUN_NOTHING_TO_RESUME'/.test(openRunBody)) {
        return falla('el conductor acepta `--resume` sin corrida abierta, y crea una nueva en silencio');
      }

      // UN CONDUCTOR POR PERIODO: sin el candado, dos operadores que contestan
      // «sí» a la vez corren el mismo mes, o el segundo continúa en silencio
      // la corrida viva del primero.
      // DE TRANSACCIÓN, sostenido por un BEGIN, y con su negativa en uso: un
      // candado de sesión se fugaba detrás de un pooler en modo transacción, y
      // uno cuyo resultado nadie mira no excluye a nadie.
      if (
        !/await client\.query\('BEGIN'\);\s*const got = await client\.query<\{ ok: boolean \}>\(\s*'SELECT pg_try_advisory_xact_lock\(hashtextextended\(\$1, 0\)\) AS ok'/.test(m) ||
        !/if \(!got\.rows\[0\]\?\.ok\) \{\s*throw new ClosingRunStateError\(\s*'CLOSING_RUN_IN_PROGRESS'/.test(m)
      ) {
        return falla(
          'el conductor ya no toma, dentro de una transacción, el candado consultivo del periodo, o ya no se niega cuando está tomado'
        );
      }
      // Y `openRun` es lo PRIMERO que ocurre dentro del candado: una escritura
      // delante —un motor corrido antes de decidir si se puede continuar— ya
      // habría posteado cuando llegue la negativa.
      if (!/return withConductorLock\(ctx\.entityId, period\.id, async \(lease\) => \{\s*const token = randomUUID\(\);\s*await lease\.assertHeld\(\);\s*const runId = await openRun\(ctx, period\.id, opts, token\);/.test(m)) {
        return falla('`openRun` ya no es lo primero que corre dentro del candado del periodo');
      }

      // SÓLO UN PERIODO ABIERTO SE CONDUCE, y la regla es del conductor; y una
      // corrida cuyo ciclo cerró otro camino se abandona antes de abrir otra,
      // para que un periodo reabierto no continúe la corrida del ciclo anterior.
      if (!/if \(periodNow !== 'open'\) \{\s*throw new ClosingRunStateError\(\s*'PERIOD_NOT_OPEN_TO_CONDUCT'/.test(m)) {
        return falla('el conductor vuelve a conducir periodos que no están abiertos');
      }
      if (!/\):\s*Promise<string> \{\s*await refuseWhileAnotherConductorActs\(ctx\.entityId, periodId\);\s*await abandonStaleRuns\(ctx\.entityId, periodId\);/.test(m)) {
        return falla('`openRun` ya no abandona, antes que nada, las corridas de un ciclo que otro camino cerró');
      }

      // LA HOJA pasa la intención tal cual, y avisa antes de preguntar.
      if (!/resume: opts\.resume === true,/.test(h)) {
        return falla(
          'la hoja ya no le dice al conductor si se pidió continuar: pasar `true` fijo saltaría la ' +
            'negativa que vive en el conductor'
        );
      }
      const courtesyAt = h.indexOf('if (existingRun && opts.resume !== true) {');
      const conductAt = h.indexOf('const outcome = await conductClose(');
      if (courtesyAt < 0 || conductAt < 0 || courtesyAt > conductAt) {
        return falla('la hoja dejó de avisar de la corrida abierta ANTES de conducir');
      }

      return ok(
        'el conductor se niega bajo el candado a continuar sin --resume y a reanudar lo que no existe, ' +
          'y la hoja avisa antes de preguntar'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "    if (opts.resume !== true) {\n      throw new ClosingRunStateError(\n        'CLOSING_RUN_OPEN',",
        a: "    if (false) {\n      throw new ClosingRunStateError(\n        'CLOSING_RUN_OPEN',",
        porque:
          'el conductor continúa en silencio la corrida que otro dejó a medias; la cortesía de la ' +
          'hoja sigue escrita y no alcanza a quien llama al conductor por otro camino',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '    const runId = await openRun(ctx, period.id, opts, token);',
        a: '    await runMonthlyProvisions(ctx.entityId, period.id, opts.userId);\n    const runId = await openRun(ctx, period.id, opts, token);',
        porque:
          'un motor postea antes de decidir si se puede continuar: la negativa llega con el mes ya tocado',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "  if (openRunRow) {\n    if (opts.resume !== true) {",
        a: "  if (openRunRow) {\n    await query(`UPDATE closing_runs SET halted_at_step = NULL WHERE id = $1`, [openRunRow.id]);\n    if (opts.resume !== true) {",
        porque:
          'la corrida abierta pierde dónde se detuvo antes de la negativa: se niega, pero ya borró lo que la negativa promete decir',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  return withConductorLock(ctx.entityId, period.id, async (lease) => {',
        a: '  return (async (lease: ConductorLease) => {',
        porque:
          'sin candado, dos conductores corren el mismo periodo a la vez y sus registros se pisan',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok'",
        a: "'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok'",
        porque:
          'el candado vuelve a ser de sesión: detrás de un pooler en modo transacción se fuga en un backend y dos conductores lo obtienen',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "    if (!got.rows[0]?.ok) {",
        a: "    if (false) {",
        porque: 'el candado se sigue tomando y su resultado ya no excluye a nadie',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "  if (periodNow !== 'open') {",
        a: '  if (false) {',
        porque: 'el conductor corre sus motores sobre un mes ya cerrado cuando alguien lo llama sin pasar por la hoja',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  await abandonStaleRuns(ctx.entityId, periodId);\n',
        a: '',
        porque:
          'la corrida del ciclo anterior sigue abierta tras reabrir el periodo: el segundo cierre se funde con el primero',
      },
      {
        archivo: 'src/cli/closing-command.ts',
        de: '          resume: opts.resume === true,',
        a: '          resume: true,',
        porque:
          'la hoja le dice siempre al conductor que se pidió continuar: la negativa del conductor ' +
          'queda desarmada desde fuera',
      },
      {
        archivo: 'src/cli/closing-command.ts',
        de: 'if (existingRun && opts.resume !== true) {',
        a: 'if (false) {',
        porque:
          'la hoja deja de avisar antes de la confirmación: el operador confirma un acto que el ' +
          'conductor le va a negar',
      },
    ],
  },

  {
    paquete: 'E4.1',
    id: 'closing-run-stops-when-it-cannot-prove-it-is-alone',
    enunciado:
      'Un conductor que pierde su candado se detiene antes del paso siguiente, nadie continúa una corrida que sigue latiendo, y el conductor desplazado no escribe sobre la corrida de otro',
    evaluar: () => {
      const conductorPath = 'src/services/accounting/closing-conductor.ts';
      const leafPath = 'src/cli/closing-command.ts';
      if (!existe(conductorPath) || !existe(leafPath)) return falla('el conductor o su hoja desaparecieron');
      const m = codigoDe(conductorPath);
      // El SQL vive en plantillas, y `codigoDe` no quita los comentarios `--`
      // de dentro de una plantilla: se lee del crudo, pero SIN comentarios —de
      // bloque y de línea, de SQL o de TypeScript—, porque una guarda comentada
      // sigue «escrita» y ya no guarda nada. Y cada consulta se compara ENTERA,
      // línea tras línea: una línea intercalada (`OR false`) desarma la guarda
      // que la sigue sin tocarla.
      const uncommented = crudoDe(conductorPath)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*(--|\/\/).*$/gm, '')
        .replace(/[ \t](--|\/\/)[ \t].*$/gm, '');
      const between = (from: string, to: string): string => {
        const a = uncommented.indexOf(from);
        const b = uncommented.indexOf(to, a + from.length);
        return a < 0 || b < 0 ? '' : uncommented.slice(a, b);
      };

      // PROBAR, LUEGO ACTUAR. La primera versión sólo notaba el candado muerto
      // cuando la corrida ya había vuelto: los motores y el cierre suave, que
      // usan el pool y no la conexión del candado, seguían mientras otro
      // conductor ya podía tomarlo (Witness, WIT-01).
      if (!/return withConductorLock\(ctx\.entityId, period\.id, async \(lease\) => \{\s*const token = randomUUID\(\);\s*await lease\.assertHeld\(\);\s*const runId = await openRun\(ctx, period\.id, opts, token\);\s*const claim: RunClaim = \{ runId, entityId: ctx\.entityId, token \};\s*const heartbeat = startRunHeartbeat\(claim, LOCK_KEEPALIVE_MS, HEARTBEAT_SILENCE_LIMIT_MS\);/.test(m)) {
        return falla('la corrida ya no prueba su candado antes de reclamar la corrida, o ya no late con su reclamo y su límite de silencio');
      }
      if (!/const checkpoint = async \(\): Promise<void> => \{\s*heartbeat\.assertBeating\(\);\s*await lease\.assertHeld\(\);\s*\};/.test(m)) {
        return falla('el punto de control dejó de comprobar el latido de la corrida y el candado');
      }
      if (!/for \(const \[i, step\] of CLOSING_STEPS\.entries\(\)\) \{\s*const ordinal = i \+ 1;\s*current = step;\s*currentRan = false;\s*currentRecorded = false;\s*await checkpoint\(\);/.test(m)) {
        return falla('la corrida real ya no prueba su candado antes de cada paso');
      }
      // EL CANDADO SE PRUEBA, no se recuerda: una sentencia sobre su propia
      // transacción. Lo ya visto sólo adelanta la respuesta.
      if (!/const known = seen\(\);\s*if \(known !== undefined\) throw lockLost\(known\);\s*try \{\s*await client\.query\('SELECT 1'\);\s*\} catch \(err\) \{\s*throw lockLost\(err\);/.test(m) ||
          !/const lease = createConductorLease\(client, \(\) => watch\.error\(\) \?\? keepalive\.lost\(\)\);/.test(m)) {
        return falla('`assertHeld` dejó de sondear la transacción del candado');
      }

      // LA NEGATIVA: la corrida queda registrada donde se detuvo, la pérdida
      // sale como estado, y dice la verdad —hasta dónde llegó el paso, y si la
      // corrida es ya de otro, lo que también sabe el cierre vigilado—.
      const stop = between('      const closing = await closeRun(', '      throw err;');
      const truth: Array<[RegExp, string]> = [
        [/const closing = await closeRun\(claim, 'failed', current\)\.then\(\s*\(\) => 'closed' as const,\s*\(closeErr: unknown\) =>\s*isLockLost\(closeErr\) && \(closeErr as ClosingRunStateError\)\.details\?\.takenOver === true\s*\? \('ended-by-another' as const\)\s*: \('unknown' as const\)\s*\);/, 'el cierre de la corrida detenida ya no dice si la corrida era ya de otro, o si ni siquiera se pudo cerrar'],
        [/if \(isLockLost\(err\)\) \{\s*const lost = err as ClosingRunStateError;\s*const taken = lost\.details\?\.takenOver === true \|\| closing === 'ended-by-another';/, 'la negativa ya no sabe que la corrida la terminó o reclamó otro'],
        [/const where = currentRecorded\s*\?\s*`after \$\{current\} and its record, without closing the run`\s*:\s*currentRan\s*\?\s*`after \$\{current\} ran, without its record`\s*:\s*`before \$\{current\}`;/, 'la negativa ya no distingue un paso no empezado, uno que corrió sin su registro y uno registrado'],
        [/const next = taken\s*\?\s*'The run was ended or taken over by another conductor; look at the period with --dry-run\.'\s*:\s*closing === 'closed'\s*\?\s*'Look at it with --dry-run and pick it up again with --resume\.'\s*:\s*'Its run could not be closed either; look at the period with --dry-run before resuming anything\.';/, 'la negativa aconseja reanudar la corrida de otro, o una que ni siquiera pudo cerrar'],
        [/throw new ClosingRunStateError\(\s*LOCK_LOST,\s*`\$\{LOCK_LOST_MESSAGE\} It stopped \$\{where\}, after \$\{steps\.length\} recorded step\(s\)\. \$\{next\}`,\s*\{\s*\.\.\.lost\.details,\s*runId,\s*haltedAtStep: current,\s*stepRan: currentRan,\s*stepRecorded: currentRecorded,\s*takenOver: taken \? true : closing === 'closed' \? false : null,/, 'la negativa ya no dice hasta dónde llegó ni qué hacer, o perdió la causa'],
      ];
      for (const [re, why] of truth) if (!re.test(stop)) return falla(why);
      if (!/outcome = stepFailed\(step, ordinal, err\);\s*\}\s*currentRan = true;/.test(m) ||
          !/steps\.push\(accumulated\);\s*currentRecorded = true;/.test(m) ||
          !/function takenOver\(\): ClosingRunStateError \{\s*return lockLost\(TAKEN_OVER, true\);/.test(m)) {
        return falla('lo que la negativa dice del paso o del relevo ya no sale de donde ocurre');
      }

      // EL LATIDO: con dueño, programado, y con silencio medido. Sólo un
      // latido que ATERRIZÓ acorta el silencio; uno que falla lo deja crecer.
      const heartbeat = between('export function startRunHeartbeat(', 'export function watchLockConnection(');
      if (!/const timer = setInterval\(beat, everyMs\);\s*return \{\s*assertBeating:/.test(heartbeat)) {
        return falla('el latido de la corrida ya no está programado');
      }
      if (!/`UPDATE closing_runs SET heartbeat_at = NOW\(\)\n\s*WHERE id = \$1 AND entity_id = \$2 AND status = 'running' AND conductor_token = \$3`,\s*\[claim\.runId, claim\.entityId, claim\.token\]\s*\);\s*if \(r\.rowCount === 0\) displaced\.push\(takenOver\(\)\);\s*lastWall = Date\.now\(\);\s*lastMono = performance\.now\(\);\s*\} catch \{\s*\}\s*\}\);\s*\};\s*const timer = setInterval\(beat, everyMs\);/.test(heartbeat) ||
          !/if \(displaced\.length > 0\) throw displaced\[0\];/.test(heartbeat)) {
        return falla('el latido ya no nota que otro conductor reclamó la corrida, o un latido que falla vuelve a contar como latido');
      }
      if (!/const silentMs = Math\.max\(Date\.now\(\) - lastWall, performance\.now\(\) - lastMono\);\s*if \(silentMs > silenceLimitMs\) throw lockLost\(/.test(heartbeat)) {
        return falla('el conductor ya no deja de empezar pasos cuando su latido lleva callado demasiado tiempo');
      }

      // LAS ESCRITURAS A LA CORRIDA LLEVAN EL RECLAMO: un conductor desplazado
      // tras una pausa larga no suma su intento ni cierra la corrida de otro.
      const record = between('async function recordStep(', 'async function closeRun(');
      if (!/`WITH owned AS \(\n\s*SELECT 1 FROM closing_runs\n\s*WHERE id = \$2 AND entity_id = \$1 AND status = 'running' AND conductor_token = \$11\n\s*FOR SHARE\n\s*\)\n\s*INSERT INTO closing_run_steps\n/.test(record) ||
          !/\$9::text\n\s*WHERE EXISTS \(SELECT 1 FROM\x20owned\)\n\s*ON CONFLICT \(run_id, step_key\) DO UPDATE SET\n/.test(record) ||
          !/accumulate,\s*claim\.token,\s*\]\s*\);\s*if \(r\.rows\.length === 0\) throw takenOver\(\);/.test(record)) {
        return falla('el registro de un paso ya no exige, con la fila bloqueada, que la corrida siga siendo de este conductor');
      }
      const close = between('async function closeRun(', 'async function periodStatus(');
      if (!/`UPDATE closing_runs\n\s*SET status = \$1, halted_at_step = \$2, ended_at = NOW\(\)\n\s*WHERE id = \$3 AND entity_id = \$4 AND status = 'running' AND conductor_token = \$5`,\s*\[status, haltedAtStep, claim\.runId, claim\.entityId, claim\.token\]\s*\);\s*if \(r\.rowCount === 0\) throw takenOver\(\);/.test(close)) {
        return falla('el cierre de la corrida ya no exige que la corrida siga siendo de este conductor');
      }

      // EL RECLAMO, Y TODA ESCRITURA DE `openRun`, VUELVEN A PREGUNTAR EN LA
      // ESCRITURA lo que se leyó antes: un conductor pausado entre la lectura
      // y la escritura despierta en un mundo que ya cambió.
      const open = between('async function openRun(', 'async function stepsOfRun(');
      if (!/\):\s*Promise<string> \{\s*await refuseWhileAnotherConductorActs\(ctx\.entityId, periodId\);/.test(open) ||
          !/if \(!\(await claimRun\(\{ runId: openRunRow\.id, entityId: ctx\.entityId, token \}\)\)\) \{\s*throw claimedByAnother\(openRunRow\.id\);/.test(open) ||
          !/if \(created === null\) throw claimedByAnother\(null\);/.test(open)) {
        return falla('`openRun` sigue adelante aunque el reclamo de la corrida no haya tomado nada');
      }
      const claimSql = between('export async function claimRun(', 'export async function startRun(');
      if (!/`UPDATE closing_runs cr\n\s*SET status = 'running', halted_at_step = NULL, ended_at = NULL,\n\s*heartbeat_at = NOW\(\), conductor_token = \$3\n\s*FROM fiscal_periods fp\n\s*WHERE cr\.id = \$1 AND cr\.entity_id = \$2\n\s*AND fp\.id = cr\.fiscal_period_id AND fp\.entity_id = cr\.entity_id\n\s*AND fp\.status = 'open'\n\s*AND \(fp\.soft_close_date IS NULL OR fp\.soft_close_date < cr\.started_at\)\n\s*AND cr\.status IN \('running', 'blocked', 'stopped', 'failed'\)\n\s*AND NOT COALESCE\(cr\.status = 'running' AND cr\.heartbeat_at > NOW\(\) - make_interval\(secs => \$4\), false\)`,\s*\[claim\.runId, claim\.entityId, claim\.token, RUN_HEARTBEAT_STALE_AFTER_SECONDS\]\s*\);\s*return r\.rowCount === 1;/.test(claimSql)) {
        return falla('el reclamo de la corrida vuelve a fiarse de lo que leyó antes de escribir');
      }
      const startSql = between('export async function startRun(', 'async function stepsOfRun(');
      if (!/SELECT \$1::uuid, \$2::uuid, 'running', \$3::uuid, NOW\(\), \$4::uuid\n\s*WHERE EXISTS \(SELECT 1 FROM fiscal_periods WHERE id = \$2 AND entity_id = \$1 AND status = 'open'\)\n\s*ON CONFLICT DO NOTHING\n\s*RETURNING id, status`/.test(startSql)) {
        return falla('una corrida nueva nace sin comprobar en la misma escritura que el periodo sigue abierto y sin otra corrida reanudable');
      }
      const abandon = between('export async function abandonStaleRuns(', 'export async function latestRunOf(');
      if (!/`UPDATE closing_runs cr\n\s*SET status = 'abandoned', ended_at = NOW\(\)\n\s*FROM fiscal_periods fp\n\s*WHERE fp\.id = cr\.fiscal_period_id AND fp\.entity_id = cr\.entity_id\n\s*AND cr\.entity_id = \$1 AND cr\.fiscal_period_id = \$2\n\s*AND cr\.status IN \('running', 'blocked', 'stopped', 'failed'\)\n\s*AND fp\.soft_close_date IS NOT NULL AND fp\.soft_close_date >= cr\.started_at\n\s*AND NOT COALESCE\(cr\.status = 'running' AND cr\.heartbeat_at > NOW\(\) - make_interval\(secs => \$3\), false\)`,\s*\[entityId, periodId, RUN_HEARTBEAT_STALE_AFTER_SECONDS\]\s*\);/.test(abandon)) {
        return falla('se abandonan corridas cuyo conductor sigue actuando: la escritura ya no lo pregunta');
      }
      const live = between('export async function liveRunOf(', 'export function describeLiveRun(');
      if (!/FROM closing_runs\n\s*WHERE entity_id = \$1 AND fiscal_period_id = \$2\n\s*AND status = 'running'\n\s*AND heartbeat_at > NOW\(\) - make_interval\(secs => \$3\)`,\s*\[entityId, periodId, RUN_HEARTBEAT_STALE_AFTER_SECONDS\]\s*\);/.test(live)) {
        return falla('la lectura de la corrida viva perdió su ventana: otro conductor continuaría una corrida viva');
      }

      // LA HOJA pregunta lo mismo que el conductor antes de aconsejar --resume,
      // en la corrida y en el ensayo.
      const h = codigoDe(leafPath);
      if (!/if \(liveRun\) throw blockedByState\(describeLiveRun\(liveRun\)\);/.test(h) ||
          !/runClosingLine\(outcome, stopAt, existingRun !== null, liveRun !== null\)/.test(h)) {
        return falla('la hoja aconseja --resume sobre una corrida que otro conductor sigue conduciendo');
      }

      // LAS VENTANAS: varios latidos antes de dar a alguien por muerto, y el
      // conductor se detiene a la mitad de esa ventana.
      const stale = /export const RUN_HEARTBEAT_STALE_AFTER_SECONDS = (\d+);/.exec(m);
      const every = /const LOCK_KEEPALIVE_MS = ([\d_]+);/.exec(m);
      if (!stale || !every || Number(stale[1]) * 1000 < 3 * Number(every[1].replace(/_/g, ''))) {
        return falla('la ventana del latido ya no cubre al menos tres latidos');
      }
      if (!/export const HEARTBEAT_SILENCE_LIMIT_MS = \(RUN_HEARTBEAT_STALE_AFTER_SECONDS \* 1000\) \/ 2;/.test(m)) {
        return falla('el límite de silencio del conductor ya no queda por debajo de la ventana en que otros lo dan por muerto');
      }

      return ok(
        'la corrida prueba candado y latido antes de reclamar y antes de cada paso, se detiene al perderlos y dice hasta dónde llegó, ' +
          'nadie reclama ni abandona una corrida que late, y cada escritura a la corrida exige seguir siendo su dueño'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        currentRecorded = false;\n        await checkpoint();\n',
        a: '        currentRecorded = false;\n',
        porque: 'la corrida sigue con el paso siguiente aunque su candado haya muerto: los motores postean sin exclusión',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      heartbeat.assertBeating();\n      await lease.assertHeld();\n',
        a: '      heartbeat.assertBeating();\n',
        porque: 'el punto de control sólo mira el latido: un candado muerto con el proceso vivo pasa por bueno',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "        await client.query('SELECT 1');\n",
        a: '',
        porque: 'el candado se da por vivo mientras nadie haya visto su muerte, en vez de probarlo',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '    const token = randomUUID();\n    await lease.assertHeld();\n',
        a: '    const token = randomUUID();\n',
        porque: 'la corrida se reclama —y se abandonan corridas— con un candado que ya podía estar muerto',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  await refuseWhileAnotherConductorActs(ctx.entityId, periodId);\n',
        a: '',
        porque:
          'sin la negativa por latido vivo, quien llama sin --resume sobre una corrida que otro conduce recibe el consejo de ' +
          'continuarla: sólo las escrituras guardadas quedan para negarse, y ninguna dice por qué',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'make_interval(secs => $4), false)',
        a: 'make_interval(secs => $4), false) OR true',
        porque: 'el reclamo de la corrida vuelve a tomar una corrida viva: dos conductores sobre el mismo mes',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '[claim.runId, claim.entityId, claim.token, RUN_HEARTBEAT_STALE_AFTER_SECONDS]',
        a: '[claim.runId, claim.entityId, claim.token, 0]',
        porque: 'la ventana del reclamo se reduce a cero: toda corrida parece muerta y cualquiera la toma',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '    if (!(await claimRun({ runId: openRunRow.id, entityId: ctx.entityId, token }))) {\n      throw claimedByAnother(openRunRow.id);\n    }\n',
        a: '    await claimRun({ runId: openRunRow.id, entityId: ctx.entityId, token });\n',
        porque: 'el reclamo no toma nada y el conductor sigue como si la corrida fuera suya: el reclamo atómico existe y nadie mira su resultado',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "        AND fp.status = 'open'\n",
        a: "        -- AND fp.status = 'open'\n",
        porque: 'un conductor pausado dentro de `openRun` despierta después de que otro cerró el mes y vuelve a poner en marcha la corrida que lo cerró; la guarda sigue escrita, comentada',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "        AND (fp.soft_close_date IS NULL OR fp.soft_close_date < cr.started_at)\n        AND cr.status IN ('running', 'blocked', 'stopped', 'failed')\n",
        a: "        AND (fp.soft_close_date IS NULL OR fp.soft_close_date < cr.started_at)\n",
        porque: 'una corrida completa o abandonada vuelve a `running` por un reclamo tardío',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "      WHERE EXISTS (SELECT 1 FROM fiscal_periods WHERE id = $2 AND entity_id = $1 AND status = 'open')\n",
        a: "      -- WHERE EXISTS (SELECT 1 FROM fiscal_periods WHERE id = $2 AND entity_id = $1 AND status = 'open')\n",
        porque: 'un conductor pausado abre una corrida nueva sobre un mes que otro ya cerró, y el expediente la toma por la corrida del cierre',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "\n        AND NOT COALESCE(cr.status = 'running' AND cr.heartbeat_at > NOW() - make_interval(secs => $3), false)`",
        a: '`',
        porque: 'un conductor que despierta tarde marca `abandoned` la corrida viva de otro que acaba de cerrar el mes',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "WHERE id = $1 AND entity_id = $2 AND status = 'running' AND conductor_token = $3`",
        a: "WHERE id = $1 AND entity_id = $2 AND status = 'running'`",
        porque: 'el latido de un conductor desplazado sigue refrescando la corrida que otro reclamó, y ninguno de los dos se entera',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        if (r.rowCount === 0) displaced.push(takenOver());\n',
        a: '',
        porque: 'alguien terminó o reclamó la corrida y el conductor sigue actuando sobre ella como si fuera suya',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '      if (silentMs > silenceLimitMs) throw lockLost(',
        a: '      if (false) throw lockLost(',
        porque: 'un proceso que despierta de una pausa más larga que la ventana empieza otro paso sobre una corrida que otro ya pudo reclamar',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  const timer = setInterval(beat, everyMs);\n  return {\n    assertBeating:',
        a: '  const timer = setTimeout(() => undefined, everyMs);\n  return {\n    assertBeating:',
        porque: 'la corrida deja de latir: a los treinta segundos otro conductor la da por muerta y la continúa encima',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        lastWall = Date.now();\n        lastMono = performance.now();\n      } catch {',
        a: '      } catch {\n        lastWall = Date.now();\n        lastMono = performance.now();',
        porque: 'un latido que falla cuenta como latido: el conductor aislado de la base nunca nota su silencio',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'startRunHeartbeat(claim, LOCK_KEEPALIVE_MS, HEARTBEAT_SILENCE_LIMIT_MS);',
        a: 'startRunHeartbeat(claim, LOCK_KEEPALIVE_MS, HEARTBEAT_SILENCE_LIMIT_MS * 1000);',
        porque: 'el límite de silencio que usa la corrida real ya no es el de la constante: la constante sigue bien escrita y nadie la usa',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "WHERE id = $2 AND entity_id = $1 AND status = 'running' AND conductor_token = $11",
        a: 'WHERE id = $2 AND entity_id = $1 AND $11::uuid IS NOT NULL',
        porque: 'un conductor desplazado suma su intento al registro de la corrida que conduce otro',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '          FOR SHARE\n',
        a: '',
        porque: 'la guarda del registro se lee de la instantánea de la sentencia: un reclamo que se confirma en medio no la detiene',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "AND status = 'running' AND conductor_token = $5`",
        a: '`',
        porque: 'un conductor desplazado marca como fallida —o como completa— la corrida viva de otro, y lo aborta',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  if (r.rowCount === 0) throw takenOver();\n}',
        a: '  // if (r.rowCount === 0) throw takenOver();\n}',
        porque: 'el cierre vigilado no toma nada y nadie se entera: la guarda sigue escrita, comentada',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'AND heartbeat_at > NOW() - make_interval(secs => $3)`,\n    [entityId, periodId, RUN_HEARTBEAT_STALE_AFTER_SECONDS]\n  );\n  return live.rows[0] ?? null;',
        a: 'AND heartbeat_at > NOW() - make_interval(secs => $3)`,\n    [entityId, periodId, 0]\n  );\n  return live.rows[0] ?? null;',
        porque: 'ningún latido es reciente: la negativa por corrida viva existe y nunca se dispara',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'export const RUN_HEARTBEAT_STALE_AFTER_SECONDS = 30;',
        a: 'export const RUN_HEARTBEAT_STALE_AFTER_SECONDS = 5;',
        porque: 'la ventana cabe en un solo latido: una pausa del proceso da por muerto a un conductor vivo y otro continúa su corrida',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'const HEARTBEAT_SILENCE_LIMIT_MS = (RUN_HEARTBEAT_STALE_AFTER_SECONDS * 1000) / 2;',
        a: 'const HEARTBEAT_SILENCE_LIMIT_MS = (RUN_HEARTBEAT_STALE_AFTER_SECONDS * 1000) * 2;',
        porque: 'el conductor sigue empezando pasos después de que otros ya lo pueden dar por muerto',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "            ? ('ended-by-another' as const)",
        a: "            ? ('unknown' as const)",
        porque: 'a quien le reclamaron la corrida entre dos pasos se le aconseja reanudarla: el cierre vigilado lo supo y se calló',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '  return lockLost(TAKEN_OVER, true);',
        a: '  return lockLost(TAKEN_OVER);',
        porque: 'un relevo se reporta como un candado perdido cualquiera, y se aconseja reanudar la corrida de otro',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        currentRan = true;\n',
        a: '',
        porque: 'un paso que ya posteó se reporta como no empezado',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        steps.push(accumulated);\n        currentRecorded = true;\n',
        a: '        steps.push(accumulated);\n',
        porque: 'un paso ya registrado se reporta como «sin su registro», contra el propio recuento de pasos registrados',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '            ...lost.details,\n',
        a: '',
        porque: 'la negativa pierde la causa del candado perdido: el operador no sabe si murió la conexión, calló el latido o lo relevaron',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        AND fp.soft_close_date IS NOT NULL AND fp.soft_close_date >= cr.started_at\n',
        a: '        AND fp.soft_close_date IS NOT NULL AND fp.soft_close_date >= cr.started_at\n        OR false\n',
        porque: 'una línea intercalada desarma la guarda de liveness de `abandonStaleRuns` sin tocarla: se abandonan corridas vivas',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "        AND fp.status = 'open'\n",
        a: "        /* AND fp.status = 'open' */\n",
        porque: 'la guarda del periodo abierto sigue escrita dentro de un comentario de bloque, y no guarda nada',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: "        AND fp.id = cr.fiscal_period_id AND fp.entity_id = cr.entity_id\n        AND fp.status = 'open'\n",
        a: "        AND fp.status = 'open'\n",
        porque: 'sin la unión con su periodo, cualquier otro periodo abierto de la entidad satisface la guarda: se reclama la corrida de un mes cerrado',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: 'recorded step(s). ${next}`',
        a: 'recorded step(s). Look at it with --dry-run and pick it up again with --resume.`',
        porque: 'la negativa calcula bien qué aconsejar y aconseja siempre reanudar, también la corrida de otro',
      },
      {
        archivo: 'src/services/accounting/closing-conductor.ts',
        de: '        // Not a verdict (see above): the silence it leaves is what counts.\n      }\n',
        a: '        // Not a verdict (see above): the silence it leaves is what counts.\n      } finally {\n        lastWall = Date.now();\n        lastMono = performance.now();\n      }\n',
        porque: 'un `finally` vuelve a contar como latido el que falló: el conductor aislado de la base nunca nota su silencio',
      },
      {
        archivo: 'src/cli/closing-command.ts',
        de: 'runClosingLine(outcome, stopAt, existingRun !== null, liveRun !== null)',
        a: 'runClosingLine(outcome, stopAt, existingRun !== null, false)',
        porque: 'el ensayo aconseja --resume sobre la corrida que otro conductor sigue conduciendo',
      },
    ],
  },

  // ---- F08a · Lo que el patrón paga y lo que el trabajador no recibió ----

  {
    paquete: 'E4.1',
    id: 'employment-subsidy-cash-delivery',
    enunciado:
      'El subsidio al empleo que excede al ISR llega al trabajador, se declara en su CFDI y se puede postear',
    evaluar: () => {
      // POR QUÉ NACE (F08a). La línea decía
      // `Math.max(0, isr.tax_amount - sub.tax_amount)` y el comentario justo
      // encima prometía «if negative, employee receives as cash». El Math.max
      // era exactamente lo que impedía que lo recibiera: cuando el subsidio al
      // empleo supera al ISR del periodo, el patrón ENTREGA la diferencia en
      // efectivo y la acredita. Ese dinero desaparecía, y el defecto no se veía
      // porque el recibo cuadraba consigo mismo — con el trabajador cobrando de
      // menos.
      //
      // Arreglarlo abrió otras dos puertas que este criterio vigila juntas,
      // porque las tres son el mismo hecho visto desde tres capas: el efectivo
      // entra en el neto (recibo), tiene que declararse como OtrosPagos 002
      // (CFDI, o Total ≠ SubTotal − Descuento y el PAC lo rechaza) y tiene que
      // tener contrapartida en el asiento (mayor, o la corrida entera no se
      // puede postear). Un criterio por capa habría dejado pasar el estado en
      // el que el trabajador cobra y la contabilidad se niega a registrarlo.
      const recibo = codigoDe('src/services/payroll/common/paycheck-service.ts');
      if (/Math\.max\(\s*0\s*,\s*isr\.tax_amount/.test(recibo)) {
        return falla(
          'paycheck-service vuelve a descartar el excedente con Math.max: el subsidio que el ' +
            'trabajador debía recibir en efectivo se pierde otra vez'
        );
      }
      if (!/subsidio_entregado_efectivo/.test(recibo)) {
        return falla('el recibo no guarda el subsidio entregado en efectivo: no hay de dónde declararlo');
      }

      const cfdi = codigoDe('src/services/payroll/mx/cfdi-nomina-generator.ts');
      if (!/TipoOtroPago="002"/.test(cfdi) || !/SubsidioAlEmpleo SubsidioCausado/.test(cfdi)) {
        return falla(
          'el CFDI de nómina no declara el subsidio entregado como OtrosPagos 002 con su ' +
            'SubsidioCausado: Total deja de ser SubTotal − Descuento y el comprobante no cuadra consigo mismo'
        );
      }

      const mayor = codigoDe('src/services/payroll/common/gl-posting-service.ts');
      if (!/isrDeLaCorrida\.lessThan\(0\)/.test(mayor)) {
        return falla(
          'el asiento de nómina no trata el ISR negativo como cargo: una corrida cuyo subsidio ' +
            'entregado supere al ISR retenido no se puede postear, y el trabajador ya cobró'
        );
      }

      return ok(
        'el excedente entra en el neto, se declara como OtrosPagos 002 con su SubsidioCausado y ' +
          'tiene contrapartida en el asiento'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/cfdi-nomina-generator.ts',
        de: 'TipoOtroPago="002"',
        a: 'TipoOtroPago="999"',
        porque:
          'el comprobante deja de declarar el subsidio entregado con la clave que el SAT cruza, y el ' +
          'criterio tiene que verlo aunque el nodo siga ahí',
      },
      {
        archivo: 'src/services/payroll/common/gl-posting-service.ts',
        de: 'isrDeLaCorrida.lessThan(0)',
        a: 'isrDeLaCorrida.lessThan(-1e9)',
        porque:
          'la rama del cargo queda escrita y nunca se toma: la corrida vuelve a descuadrarse por el ' +
          'importe entregado, que es el defecto original con una condición imposible en vez de un Math.max',
      },
    ],
  },
  {
    paquete: 'E4.1',
    id: 'isn-refuses-instead-of-zero',
    enunciado: 'Un impuesto que no se puede calcular se nombra, no se cifra en cero',
    evaluar: () => {
      // POR QUÉ NACE (F08a). El ISN —impuesto estatal sobre nóminas, carga del
      // patrón, del 1% al 4%— no existía en una sola línea de código. Al nacer,
      // el riesgo inmediato no era calcularlo mal: era calcularlo en CERO. La
      // tabla de tasas nace VACÍA a propósito (32 estados con tasas que cambian
      // por decreto; sembrarlas de memoria es fabricar un número plausible), así
      // que el motor tiene que negarse con nombre y apellido en vez de devolver
      // un cero que se suma sin protestar.
      const p = 'src/services/payroll/mx/isn-calculator.ts';
      if (!existe(p)) return falla('no hay calculador de ISN: el impuesto sobre nóminas sigue sin existir');
      const isn = codigoDe(p);
      const negativas = ['isn_sin_tasa_capturada', 'isn_regimen_no_soportado', 'isn_sin_estado_en_el_trabajador'];
      const faltan = negativas.filter((h) => !isn.includes(h));
      if (faltan.length > 0) {
        return falla(
          `el motor del ISN no se niega ante ${faltan.join(', ')}: un estado sin tasa capturada, un ` +
            'régimen que no sabe calcular o un trabajador sin estado producirían un cero con aspecto de resultado'
        );
      }
      return ok('las tres negativas del ISN nombran lo que falta en vez de cifrar un cero');
    },
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/isn-calculator.ts',
        de: 'isn_regimen_no_soportado',
        a: 'isn_regimen_ya_veremos',
        porque:
          'un régimen escalonado calculado como si fuera tasa plana da un importe plausible y falso, ' +
          'y el criterio sólo lo ve si exige el hallazgo por su nombre',
      },
    ],
  },

  // ---- T20·6 · La cuota que el trabajador no debía ----

  {
    paquete: 'E4.1',
    id: 'imss-employee-rates-match-law',
    enunciado: 'Las cuotas obreras del IMSS sembradas son las de la ley, y ninguna es copia de la de al lado',
    mutantes: [
      {
        archivo: 'src/database/migrations/070_la_cuota_que_el_trabajador_no_debia.sql',
        de: "to_jsonb(0.004::numeric)",
        a: "to_jsonb(0.00625::numeric)",
        porque: 'la corrección deja de corregir: vuelve el sobrecobro del 56 % en el ramo de enfermedades y maternidad a todo trabajador con SBC sobre tres UMA, y sale en el recibo, en el CFDI de nómina y en la línea de captura',
      },
      {
        archivo: 'src/database/migrations/070_la_cuota_que_el_trabajador_no_debia.sql',
        de: "RAISE EXCEPTION 'La cuota obrera de enfermedades y maternidad sigue en 0.00625",
        a: "RAISE NOTICE 'La cuota obrera de enfermedades y maternidad sigue en 0.00625",
        porque: 'un relleno que no alcanzó ninguna fila deja de detener la actualización: la migración se registra como aplicada sobre datos que siguen mal, que es la clase de silencio que este proyecto persigue',
      },
      {
        archivo: 'src/database/migrations/070_la_cuota_que_el_trabajador_no_debia.sql',
        de: "to_jsonb(0.004::numeric)",
        a: "to_jsonb(0.0045::numeric)",
        porque: 'EL AGUJERO QUE ESTE ESPEJO CIERRA: el regex anterior no cerraba el número, así que 0.0045 —un 12.5 % de sobrecobro— pasaba como si fuera 0.004. Un ancla que no acota por la derecha da por buena cualquier cifra que EMPIECE por la correcta',
      },
    ],
    evaluar: () => {
      // T20 punto 6 (#127). `imss_employee.enfermedades_maternidad` se sembró en
      // la 009 con 0.00625 —el valor de `invalidez_vida`, la casilla de al
      // lado— donde el art. 106-II LSS fija 0.40 %. Un 56.25 % de más sobre el
      // excedente de tres UMA, retenido a una persona en cada recibo.
      //
      // Este criterio vigila el DATO, no el motor: `imss-calculator.ts` estaba
      // bien y no se tocó.
      const corr = 'src/database/migrations/070_la_cuota_que_el_trabajador_no_debia.sql';
      if (!existe(corr)) {
        return falla('desapareció la migración que corrige la cuota obrera de enfermedades y maternidad: las bases ya instaladas volverían a cobrar 0.00625 (#127)');
      }
      const sql = crudoDe(corr);
      if (!/enfermedades_maternidad\}'\s*,\s*to_jsonb\(0\.004::numeric\)/.test(sql)) {
        return falla('la corrección dejó de fijar 0.004: el art. 106-II LSS manda 0.40 % y cualquier otro número es dinero retenido de más');
      }
      // Y no puede pasar callada si no alcanzó ninguna fila: seguir sería
      // registrar la migración como aplicada sobre datos que siguen mal.
      if (!/RAISE EXCEPTION[\s\S]{0,120}sigue en 0\.00625/.test(sql)) {
        return falla('la corrección dejó de detenerse cuando queda alguna fila en 0.00625: un relleno que no rellena nada volvería a pasar en silencio');
      }

      // LA SEMILLA. La 009 se deja como registro histórico, pero sus OTRAS
      // cuatro cuotas obreras sí tienen que seguir siendo las de la ley: son
      // las que hacen creíble que el error estaba aislado.
      const semilla = crudoDe('src/database/migrations/009_tax_tables_2026.sql');
      const bloque = semilla.slice(semilla.indexOf('"imss_employee"'), semilla.indexOf('"imss_employer"'));
      const legales: Array<[string, string]> = [
        ['prestaciones_dinero', '0.0025'],
        ['gastos_medicos_pensionados', '0.00375'],
        ['invalidez_vida', '0.00625'],
        ['cesantia_vejez', '0.01125'],
      ];
      const torcida = legales.find(([k, v]) => !new RegExp(`"${k}"\\s*:\\s*${v.replace('.', '\\.')}\\b`).test(bloque));
      if (torcida) {
        return falla(`la cuota obrera «${torcida[0]}» dejó de valer ${torcida[1]}: las cuatro que estaban bien son lo que prueba que el error de enfermedades y maternidad estaba aislado`);
      }
      // Y LA PAREJA DEL MISMO ARTÍCULO. El 106-II fija dos cuotas sobre el
      // mismo excedente: patrón 1.10 % y trabajador 0.40 %. Si la patronal se
      // tuerce, la pareja deja de poder comprobarse contra sí misma.
      return /"enfermedades_maternidad_excedente"\s*:\s*0\.011\b/.test(semilla)
        ? ok('la cuota obrera de enfermedades y maternidad se corrige a 0.004, con las otras cuatro y la patronal del mismo artículo intactas')
        : falla('la cuota PATRONAL del art. 106-II dejó de valer 0.011: era la mitad de la pareja que permitía comprobar la obrera contra la ley');
    },
  },

  {
    paquete: 'E4.1',
    id: 'seniority-premium-is-paid-and-capped-by-zone',
    enunciado: 'El finiquito paga la prima de antigüedad, topada por el art. 486, y no la cifra en cero cuando no la puede calcular',
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/finiquito-math.ts',
        de: "  return motivo === 'renuncia' ? aniosCumplidos >= 15 : true;",
        a: "  return motivo === 'renuncia' && aniosCumplidos >= 15;",
        porque:
          'vuelve a no pagarse la prima al DESPEDIDO, que es la mitad del art. 162 fr. III que más se pasa por alto: se paga «independientemente de la justificación o injustificación del despido». Un despedido con tres años pierde 22 682.88',
      },
      {
        archivo: 'src/services/payroll/mx/finiquito-math.ts',
        de: '  return Decimal.min(piso, salarioMinimo.times(2));',
        a: '  return piso;',
        porque:
          'desaparece el tope del art. 486 y la prima se calcula sobre el salario entero: para un salario de 1 000 con quince años son 180 000 en vez de 113 414.40 — pagar de más también es un defecto, y aquí lo paga el patrón',
      },
      {
        archivo: 'src/services/payroll/mx/finiquito-math.ts',
        de: "      'SIN CALCULAR: faltó el salario mínimo de la zona",
        a: "      'sin prima de antigüedad en este finiquito. Faltó el mínimo de la zona",
        porque:
          'el cero por no saber vuelve a ser indistinguible del cero por no deberse: sin el mínimo de la zona no se puede fijar el tope, y callarlo le paga de menos al trabajador sin que nadie lo note',
      },
    ],
    evaluar: () => {
      // T4b (#91). `calcularFiniquito` sumaba cuatro conceptos y llamaba
      // `total` al resultado. Faltaba la prima de antigüedad —doce días por
      // año de servicio, art. 162 LFT—, que en el caso medido (quince años,
      // salario diario 1 000) son 113 414.40 contra un finiquito de 24 610.96:
      // faltaba más de cuatro veces lo que se pagaba.
      const math = 'src/services/payroll/mx/finiquito-math.ts';
      if (!existe(math)) return falla('desapareció la aritmética del finiquito');
      const src = codigoDe(math);

      // 1. QUE SE CALCULE Y ENTRE EN EL TOTAL.
      if (!/prima_antiguedad_importe/.test(src)) {
        return falla('el finiquito volvió a no pagar la prima de antigüedad: son doce días por año de servicio y en un trabajador antiguo es la prestación más grande (#91)');
      }
      // 2. QUE EL TOPE SEA DEL ART. 486 Y SOBRE EL SALARIO, no sobre el
      //    resultado: «se considerará esa cantidad como salario MÁXIMO».
      if (!/Decimal\.min\(piso, salarioMinimo\.times\(2\)\)/.test(src)) {
        return falla('la base de la prima dejó de topar el salario en dos mínimos (LFT art. 486): topar el resultado da otra cifra, y no topar nada se lo cobra al patrón');
      }
      // 3. QUE EL DESPIDO LA COBRE SIN UMBRAL.
      if (!/motivo === 'renuncia' \? aniosCumplidos >= 15 : true/.test(src)) {
        return falla('sólo la renuncia tiene umbral de quince años: el despido paga prima «independientemente de la justificación o injustificación» (art. 162 fr. III)');
      }
      // 4. Y QUE EL CERO POR NO SABER SE NOMBRE. El tope cuelga del salario
      //    mínimo DE LA ZONA, que este esquema todavía no guarda: suponer el
      //    general le paga 45 298.80 de menos a un trabajador fronterizo.
      if (!/SIN CALCULAR/.test(src)) {
        return falla('un finiquito sin el salario mínimo de la zona vuelve a devolver cero sin decirlo: indistinguible de no deberse');
      }

      return existe('tests/payroll/mx/prima-de-antiguedad.spec.ts')
        ? ok('la prima de antigüedad se paga con su tope del art. 486, el despido la cobra sin umbral, y lo que no se puede calcular se nombra')
        : falla('no hay prueba de la prima de antigüedad: la prestación más grande del finiquito quedaría sin vigilar');
    },
  },

  {
    paquete: 'E4.1',
    id: 'isr-tariff-matches-the-pay-period',
    enunciado: 'A cada periodo de pago se le aplica SU tarifa del art. 96, y el periodo sin tabla publicada se niega',
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/isr-calculator.ts',
        de: "    case 'weekly': return 'weekly';",
        a: "    case 'weekly': return 'monthly';",
        porque:
          'EL DEFECTO MEDIDO (#91): la tarifa MENSUAL aplicada a la base de una SEMANA. Con ella, 3 000 semanales retenían 0.00 y 7 000 retenían 190.96 — subretención de entre el 85 % y el 100 % en cada recibo, que se le cobra al patrón con recargos',
      },
      {
        archivo: 'src/database/migrations/073_la_tarifa_que_si_es_de_este_ano.sql',
        de: "('MX','isr',2026,NULL,'monthly', 1,      0.01,     844.59,",
        a: "('MX','isr',2026,NULL,'monthly', 1,      0.01,     746.04,",
        porque:
          'vuelve la tarifa de 2025 sembrada como 2026 — el defecto que la 009 arrastraba y que hace que TODA retención del ejercicio salga con la tabla del año pasado',
      },
    ],
    evaluar: () => {
      // T4 (#91). `isr-calculator.ts` hacía
      // `pay_frequency === 'quincenal' ? 'quincenal' : 'monthly'`, así que tres
      // periodos de pago recibían la tarifa mensual sobre la base de una
      // semana. Y debajo había algo peor: la tarifa sembrada como 2026 era la
      // de 2025 al centavo, y la «quincenal» no era la de ningún año —el
      // archivo lo confesaba: «same structure, divided by 2»—, cuando el
      // Anexo 8 la construye como la diaria por 15.
      const calc = 'src/services/payroll/mx/isr-calculator.ts';
      if (!existe(calc)) return falla('desapareció la calculadora de ISR');
      const src = codigoDe(calc);

      // 1. LA SUSTITUCIÓN SILENCIOSA, MUERTA. Ese ternario ERA el defecto.
      if (/pay_frequency === 'quincenal' \? 'quincenal' : 'monthly'/.test(src)) {
        return falla('la calculadora vuelve a mandar weekly, biweekly y semimonthly a la tarifa MENSUAL: subretiene entre el 85 % y el 100 % en cada recibo (#91)');
      }
      // 2. Y EL PERIODO SIN TABLA SE NOMBRA, no se adivina.
      if (!/No hay tarifa del art\. 96 publicada para el periodo/.test(src)) {
        return falla('el periodo sin tarifa publicada dejó de negarse: la catorcena no tiene tabla en el Anexo 8, y sustituirla en silencio es el defecto original con otro número');
      }
      if (!/case 'weekly': return 'weekly';/.test(src)) {
        return falla('el sueldo semanal dejó de usar la tarifa semanal del Anexo 8');
      }

      // 3. LA TARIFA SEMBRADA ES LA DE ESTE AÑO. 844.59 es el primer límite de
      //    2026; 746.04 es el de 2025, que es lo que había.
      const mig = 'src/database/migrations/073_la_tarifa_que_si_es_de_este_ano.sql';
      if (!existe(mig)) {
        return falla('desapareció la migración que corrige la tarifa: la instalación vuelve a retener con la tabla del año pasado (#91)');
      }
      const sql = crudoDe(mig);
      if (!/'monthly', 1,\s+0\.01,\s+844\.59,/.test(sql)) {
        return falla('la tarifa mensual de 2026 dejó de ser la publicada en el Anexo 8: toda retención del ejercicio saldría con otra tabla');
      }

      // 4. Y SE COMPRUEBA CORRIENDO. Las cuatro tarifas del periodo se DERIVAN
      //    de la mensual, así que lo que hay que vigilar no es la
      //    transcripción sino que la derivación siga reproduciendo lo publicado.
      return existe('tests/integration/t4-tarifa-del-periodo.int.spec.ts')
        ? ok('cada periodo usa su tarifa del Anexo 8, el que no tiene tabla se niega, la sembrada es la de 2026 y hay prueba que lo ejecuta contra la base')
        : falla('no hay prueba que EJECUTE la retención por periodo: leer la calculadora no demuestra qué se le retiene a un sueldo semanal');
    },
  },

  {
    paquete: 'E4.1',
    id: 'imss-rate-fix-verified-by-running-it',
    enunciado: 'La corrección de la cuota obrera se comprueba EJECUTÁNDOLA sobre una base migrada, no leyéndola',
    mutantes: [
      {
        archivo: 'tests/integration/migracion-070-cuota-obrera.int.spec.ts',
        de: "describe('la 070 sobre una instalación que ya cobraba de más'",
        a: null,
        porque:
          'si la prueba desaparece, la única defensa de un parámetro fiscal vuelve a ser un regex sobre el archivo: el criterio debe dar ROJO, no reventar leyendo una prueba que ya no está',
      },
      {
        archivo: 'tests/integration/migracion-070-cuota-obrera.int.spec.ts',
        de: 'for (const archivo of migracionesHasta(69))',
        a: 'for (const archivo of migracionesHasta(70))',
        porque:
          'la base deja de ser PRE-070 y la 070 se aplica en el montaje: la prueba seguiría verde comprobando el resultado de su propio andamio en vez del efecto de la migración — el escenario que se mide a sí mismo',
      },
    ],
    evaluar: () => {
      // POR QUÉ ESTE CRITERIO EXISTE, teniendo ya el de arriba. El de arriba
      // lee el .sql y comprueba que el número esté ESCRITO: da verde con la
      // migración escrita y no aplicada. Es el mismo falso verde que pagaron
      // los criterios de la 040 y la 043 —vigilaban el DML, no el efecto—
      // hasta que se convirtieron en criterios que preguntan a los datos.
      //
      // Medido: con `to_jsonb(0.0045::numeric)` el tablero seguía en verde
      // mientras la prueba de integración caía en cuatro sitios. Un parámetro
      // fiscal que se retiene a una persona no puede quedar defendido sólo por
      // una expresión regular.
      const prueba = 'tests/integration/migracion-070-cuota-obrera.int.spec.ts';
      if (!existe(prueba)) {
        return falla('no hay prueba que EJECUTE la 070: el criterio de arriba sólo lee el archivo, y un regex da por aplicada una migración que nadie corrió (#127)');
      }
      const t = crudoDe(prueba);

      // 1. QUE CORRA EL ARCHIVO REAL, no una copia del SQL dentro de la
      //    prueba: una copia se queda vieja el día que alguien toque la
      //    migración, y entonces la prueba pasa a defender el pasado.
      if (!/readFileSync\(path\.join\(DIR, ARCHIVO_070\)/.test(t)) {
        return falla('la prueba dejó de leer la migración de disco: si prueba una copia, deja de probar lo que se despliega');
      }

      // 2. QUE EL ESTADO SEA HISTÓRICO DE VERDAD. La fila equivocada la tiene
      //    que sembrar la 009 sobre una base PRE-070, no la propia prueba: si
      //    el montaje aplicara la 070, mediría su propio andamio.
      if (!/for \(const archivo of migracionesHasta\(69\)\)/.test(t)) {
        return falla('la prueba dejó de montar una base PRE-070: el estado histórico se lo estaría fabricando ella misma');
      }

      // 3. QUE JUZGUE LA CIFRA Y LA VECINDAD. 0.004 es el art. 106-II; que
      //    `invalidez_vida` siga en 0.00625 es lo que impide el arreglo de
      //    brocha gorda que borra todo 0.00625 del JSON y rompe el art. 147.
      if (!/toBe\('0\.004'\)/.test(t) || !/invalidez_vida/.test(t)) {
        return falla('la prueba dejó de exigir 0.004 con las otras cuatro cuotas intactas: sin la vecindad, un arreglo de brocha gorda pasaría');
      }

      // 4. Y QUE VIGILE EL REGISTRO. Lo que hace peligrosa a una migración de
      //    datos no es fallar: es quedar ANOTADA habiendo fallado, porque
      //    entonces nadie la reintenta.
      return /anotadaLa070\(\)/.test(t)
        ? ok('la 070 se ejecuta sobre una base migrada hasta la 069: corrige, respeta a las vecinas, avisa del valor ajeno, se puede reejecutar, y cuando su guarda salta no queda anotada')
        : falla('la prueba dejó de mirar public.migrations: una migración que aborta pero queda anotada no la reintenta nadie, y la instalación se queda cobrando de más');
    },
  },

  {
    paquete: 'E4.1',
    id: 'policy-number-checked-on-read-and-write',
    // EL PANEL ES DONDE EL DESPACHO DECLARA SU CRITERIO, Y DE AHÍ SALE DINERO.
    //
    // `resolvePolicy` aceptaba cualquier cadena y sólo anotaba «[value outside
    // the catalog]». Medido contra Postgres: `prima_vacacional_pct = '25'`
    // —un contador leyendo la etiqueta «25 %» del propio catálogo, que guarda
    // '0.25'— pagaba 275.000,00 donde tocaban 2.750,00, y lo mismo por el
    // cuerpo de POST /finiquito, que prefería su campo sobre la política.
    //
    // TRES PIEZAS, Y LAS TRES HACEN FALTA:
    //
    //  1. La cota de FORMA (`PolicyDomain`) en la ESCRITURA y en la LECTURA.
    //     Sólo en la escritura deja vivo el ×100 de las filas ya resueltas y
    //     de los `default_value` sembrados desde un catálogo viejo, que
    //     `seedPolicies` no revisita. Sólo en la lectura deja que la errata se
    //     archive bajo el sello «tu despacho decidió esto» y estalle dos
    //     semanas después, el día de una baja.
    //  2. El PISO DE LA LEY, que no es lo mismo y no vive aquí: vive en
    //     `legal_parameters`, con fecha de entrada y fuente, porque una
    //     constante en TypeScript no sabe desde cuándo rige. Y se comprueba
    //     con la fecha del HECHO: recalcular una baja de 2019 contra el mínimo
    //     de hoy es otra cifra.
    //  3. Y ninguna segunda puerta: un criterio contable no se decide en el
    //     JSON de una petición, sin autor, sin fecha y sin fila.
    enunciado:
      'Un número del panel no puede salir de su unidad ni bajar del mínimo de la ley, ni entrar por el cuerpo de una petición',
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: '    validarDominio(spec, row.resolved_value);',
        a: '    // validarDominio(spec, row.resolved_value);',
        porque:
          'la guarda de escritura sólo ve respuestas NUEVAS: una fila ya resuelta con 25 —o sembrada desde un catálogo viejo, que seedPolicies no revisita— vuelve a convertirse en un importe cien veces mayor',
      },
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: '  validarDominio(spec, value);',
        a: '  // validarDominio(spec, value);',
        porque:
          'la errata deja de detenerse en el teclado: `pending define prima_vacacional_pct 25` vuelve a imprimir «✔» y el fallo aparece el día que alguien causa baja, ya archivado como decisión del despacho',
      },
      {
        archivo: 'src/services/payroll/mx/finiquito-calculator.ts',
        de: "      String(await getPolicyNumber(panel, 'dias_aguinaldo')),\n      input.termination_date",
        a: "      String(await getPolicyNumber(panel, 'dias_aguinaldo')),\n      new Date().toISOString().slice(0, 10)",
        porque:
          'el piso se mide contra la ley de HOY y no contra la de la baja: un finiquito reexpedido de un año anterior deja de dar el mismo número, que es exactamente la pregunta que la 080 existe para contestar',
      },
      {
        archivo: 'src/services/accruals/provisions-run.ts',
        de: "  const dias = Number(\n    await exigirPisoLegal('dias_aguinaldo', String(await getPolicyNumber(ctx, 'dias_aguinaldo')), enFecha)\n  );",
        a: "  const dias = await getPolicyNumber(ctx, 'dias_aguinaldo');",
        porque:
          'el finiquito queda blindado y la corrida mensual sigue acreditando al mayor un aguinaldo ilegal, mes tras mes y posteando sola: es el ÚNICO camino de estas claves que escribe en los libros',
      },
    ],
    evaluar: () => {
      const svc = 'src/services/policy/policy-service.ts';
      const cat = 'src/services/policy/pending-catalog.ts';
      const fin = 'src/services/payroll/mx/finiquito-calculator.ts';
      const prov = 'src/services/accruals/provisions-run.ts';
      const prueba = 'tests/integration/t6-el-panel-que-acepta-cualquier-numero.int.spec.ts';
      for (const f of [svc, cat, fin, prov]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }
      const s = codigoDe(svc);

      // 1. LA COTA, EN LAS DOS PUERTAS Y EN SU SITIO.
      //
      // POR ÍNDICE Y NO POR PRESENCIA. Es la trampa que este tramo vio caer
      // dos veces: un criterio que sólo pregunta «¿está la llamada?» deja vivo
      // al mutante que la mueve detrás del `return`, donde no sirve de nada.
      const iBlanco = s.indexOf("value.trim() === ''");
      const iEscritura = s.indexOf('validarDominio(spec, value)');
      const iUpdate = s.indexOf('UPDATE policy_decisions');
      if (iBlanco < 0 || iEscritura < 0 || iUpdate < 0) {
        return falla(
          'la guarda de dominio desapareció de la escritura: `pending define prima_vacacional_pct 25` vuelve a guardarse como decisión del despacho'
        );
      }
      if (!(iBlanco < iEscritura && iEscritura < iUpdate)) {
        return falla(
          'la guarda de dominio ya no está entre la del blanco y el UPDATE: comprobar después de escribir no comprueba nada'
        );
      }
      const iResuelta = s.indexOf('validarDominio(spec, row.resolved_value)');
      const iReturnResuelta = s.indexOf('value: row.resolved_value, defined: true');
      const iRespaldo = s.indexOf('validarDominio(spec, fallback)');
      const iReturnRespaldo = s.indexOf('value: fallback, defined: false');
      if (iResuelta < 0 || iRespaldo < 0) {
        return falla(
          'la guarda de dominio desapareció de la LECTURA: las filas ya resueltas y los default_value de un catálogo viejo vuelven a convertirse en importes'
        );
      }
      if (!(iResuelta < iReturnResuelta && iRespaldo < iReturnRespaldo)) {
        return falla(
          'la guarda de dominio quedó DESPUÉS de su return: el valor sale sin pasar por ella, que es el mutante que una comprobación de mera presencia no mata'
        );
      }

      // 2. EL PISO DE LA LEY VIVE EN LA LEY, Y EN LOS DOS SITIOS.
      const c = codigoDe(cat);
      for (const clave of ['dias_aguinaldo', 'prima_vacacional_pct']) {
        const desde = c.indexOf(`key: '${clave}'`);
        if (desde < 0) return falla(`${cat} ya no declara ${clave}`);
        const bloque = c.slice(desde, desde + 2000);
        if (!/dominio: \{/.test(bloque)) {
          return falla(`${clave} perdió su dominio: vuelve a ser una cadena cualquiera de la que sale dinero`);
        }
        if (!/pisoLegal: \{/.test(bloque)) {
          return falla(`${clave} perdió su piso legal: el panel vuelve a poder ofrecer bajar del mínimo de la ley`);
        }
      }
      // La semilla SOLA no basta: `legal_parameters` nace vacía en toda base
      // migrada y no sembrada —incluida la de la suite de integración—, así
      // que sin migración esto no es una guarda, es un apagón.
      // `fuentes()` sólo devuelve .ts: las migraciones son .sql y se leen por
      // el seam con `crudoDe`, como hace el resto del tablero.
      const dirMigraciones = 'src/database/migrations';
      const sqlDeTodas = fs
        .readdirSync(rutaDe(dirMigraciones))
        .map((m) => crudoDe(dirMigraciones, m))
        .join('\n');
      const sembrada = /INSERT INTO legal_parameters/i.test(sinProsa(sqlDeTodas));
      if (!sembrada) {
        return falla(
          'ninguna migración inserta en legal_parameters: el piso se lee de una tabla vacía y el finiquito deja de calcularse en toda base migrada sin sembrar'
        );
      }

      // 3. Y SE MIDE CON LA FECHA DEL HECHO, en los dos consumidores.
      const f = codigoDe(fin);
      // UNA POR UNA, y no «que aparezca en el archivo». La primera redacción
      // buscaba `exigirPisoLegal(...input.termination_date` en cualquier parte
      // y su propio mutante la sobrevivió: cambiar la fecha de UNA de las dos
      // llamadas dejaba la otra emparejando. Cada llamada se mira sola, y el
      // reloj de pared se prohíbe por nombre.
      const llamadas = [...f.matchAll(/exigirPisoLegal\(/g)];
      if (llamadas.length < 2) {
        return falla(
          `el finiquito sólo envuelve ${llamadas.length} de sus 2 lecturas del panel con el piso legal: la que queda suelta vuelve a poder pagar por debajo de la ley`
        );
      }
      for (const m of llamadas) {
        const args = f.slice(m.index, m.index + 260);
        if (/new Date\(|Date\.now\(/.test(args)) {
          return falla(
            'el piso se mide con el reloj de pared y no con la fecha del hecho: un finiquito reexpedido de un año anterior deja de dar el mismo número, que es justo lo que la 080 le puso fecha a la ley para contestar'
          );
        }
        if (!/input\.termination_date/.test(args)) {
          return falla(
            'una de las llamadas al piso legal dejó de recibir la fecha de la BAJA: el mínimo que se le aplica ya no es el que regía cuando el hecho ocurrió'
          );
        }
      }
      const p = codigoDe(prov);
      if (!/exigirPisoLegal\('dias_aguinaldo'/.test(p) || !/exigirPisoLegal\('prima_vacacional_pct'/.test(p)) {
        return falla(
          'la corrida de provisiones dejó de exigir el piso: es el único camino de estas claves que ESCRIBE en el mayor, y postea solo'
        );
      }

      // 4. NINGUNA SEGUNDA PUERTA.
      if (/input\.(aguinaldo_days_per_year|prima_vacacional_pct)/.test(f)) {
        return falla(
          'volvió el campo del cuerpo que sobrescribe el panel: un criterio contable decidido en un JSON, sin autor, sin fecha y sin fila'
        );
      }

      // 5. Y CONDUCTA QUE LO AFIRMA CONTRA POSTGRES.
      if (!existe(prueba)) {
        return falla('no hay reproducción del panel: sin ella esto es una lectura del diff');
      }
      const t = crudoDe(prueba);
      if (!/toBe\(422\)/.test(t)) {
        return falla(
          'la reproducción dejó de exigir el 422 que NOMBRA el campo retirado: un descarte mudo empieza a pagar otra cantidad sobre un finiquito real sin que nadie se entere'
        );
      }
      if (!/mínimo de 15\\.0000/.test(t)) {
        return falla(
          'la reproducción dejó de exigir que el rechazo cite la CIFRA de la ley: «el sistema no me deja» y «el art. 87 no te deja» no son lo mismo para quien lo lee'
        );
      }

      return ok(
        'el dominio se comprueba al escribir y al leer y en su sitio, el piso vive en legal_parameters con migración y se mide con la fecha del hecho, y el cuerpo ya no puede imponer un criterio'
      );
    },
  },
  {
    paquete: 'E4.1',
    id: 'sua-file-declares-the-month-and-only-the-month',
    // EL ÚNICO DE VÍA A QUE ESTABA ROTO POR OMISIÓN (#92).
    //
    // Sin atacante, sin dato mal tecleado, sin permiso de más: el archivo que
    // el patrón carga en el SUA para pagarle al IMSS y al INFONAVIT declaraba
    // las cuotas de TODA la historia del empleado. El mecanismo no era un
    // `WHERE` ausente sino una forma: las condiciones de mes y de estado
    // vivían en los `ON` de dos `LEFT JOIN` posteriores al de `paychecks`, y
    // ahí no descartan la fila —la dejan con las tablas de la derecha en NULL
    // y el recibo intacto—. Los días, que salían de la tabla que sí se anula,
    // sí quedaban acotados: 31 días cotizados junto a la cuota de siete
    // quincenas, medido, en el mismo renglón del archivo.
    //
    // POR ESO SE VIGILAN DOS COSAS Y NO UNA. Que los filtros vivan donde
    // filtran, y que la cifra la confirme un SEGUNDO camino: el pasivo que
    // `acumularPasivoPatronal` apuntó al aprobar. Un cotejo por el mismo
    // código no mediría nada —es la lección de la ida y vuelta—, y sin cotejo
    // la próxima forma de contar de más vuelve a salir en silencio.
    enunciado:
      'El archivo del SUA declara las cuotas del mes, y ninguna otra, y no sale si contradice el pasivo ya apuntado',
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/sua-generator.ts',
        de: '     ) m ON m.employee_id = e.id',
        a: '     ) m ON TRUE',
        porque:
          'los movimientos del mes dejan de colgar del empleado: cada trabajador se lleva las cuotas de TODA la plantilla, y el archivo que se sube al SUA multiplica por el número de empleados',
      },
      {
        archivo: 'src/services/payroll/mx/sua-generator.ts',
        de: "        WHERE pr.status IN ('approved', 'paid')",
        a: '        WHERE TRUE',
        porque:
          'una corrida en borrador —un recálculo que nadie aprobó— vuelve a declararse como cuota a pagar: el patrón le paga al IMSS por un cálculo que su propio despacho no cerró',
      },
      {
        archivo: 'src/services/payroll/mx/sua-generator.ts',
        de: '  if (bloqueantes.length > 0) {',
        a: '  if (false) {',
        porque:
          'el archivo vuelve a entregarse aunque contradiga el pasivo que el patrón ya apuntó: se persiste un `draft` descuadrado, que es justo el que alguien sube al SUA sin volver a mirarlo',
      },
    ],
    evaluar: () => {
      const gen = 'src/services/payroll/mx/sua-generator.ts';
      const prueba = 'tests/integration/t5-sua-el-multiplicador.int.spec.ts';
      if (!existe(gen)) return falla(`desapareció ${gen}`);
      const src = codigoDe(gen);

      // 1. NINGÚN FILTRO DE LOS QUE ACOTAN VIVE EN UN `ON` DE `LEFT JOIN`.
      //
      // Se mide la forma y no el texto exacto del SQL, porque la forma ES el
      // defecto: un `LEFT JOIN` cuyo `ON` lleva la condición no filtra, y esa
      // trampa se puede volver a escribir con otras palabras.
      const izquierdos = src.match(/LEFT JOIN[\s\S]{0,300}?(?=\n\s*(?:LEFT JOIN|JOIN|WHERE|GROUP BY|\)))/g) ?? [];
      for (const j of izquierdos) {
        if (/\bON\b[\s\S]*?\b(status|period_start|period_end)\b/.test(j)) {
          return falla(
            'el SUA volvió a colgar el filtro de mes o de estado del `ON` de un LEFT JOIN: ahí no descarta el recibo, lo deja con las tablas de la derecha en NULL y la cuota sigue sumando — la historia entera del empleado en el archivo del IMSS'
          );
        }
      }
      // Y ESTÁN LAS TRES PIEZAS, cada una con su llave.
      //
      // Se fija el texto a propósito: son cuatro líneas de SQL sin tripas,
      // donde el texto ES la conducta. La primera redacción comprobaba sólo
      // que las tablas estuvieran unidas y sus dos mutantes la sobrevivieron
      // —`ON TRUE` y `WHERE TRUE` dejan los nombres escritos—, que es
      // exactamente la falta de comprobar el destino de un salto y no su
      // llave.
      const piezas: Array<[RegExp, string]> = [
        [
          /FROM paychecks p\s+JOIN pay_runs pr/,
          'los movimientos del mes dejaron de armarse con JOIN interno: sin él una condición que no se cumple no elimina la fila',
        ],
        [
          /\)\s*m ON m\.employee_id = e\.id/,
          'los movimientos del mes dejaron de colgar del empleado por su llave: cada trabajador se lleva las cuotas de toda la plantilla',
        ],
        [
          /pr\.status IN \('approved', 'paid'\)/,
          'el archivo del SUA dejó de exigir que la corrida esté aprobada: un recálculo en borrador vuelve a declararse como cuota a pagar',
        ],
        [
          /pp\.period_start >= \$3 AND pp\.period_end <= \$4/,
          'el archivo del SUA dejó de acotar los recibos al mes que declara',
        ],
      ];
      for (const [ancla, porque] of piezas) {
        if (!ancla.test(src)) return falla(porque);
      }

      // 2. LA CIFRA LA CONFIRMA UN SEGUNDO CAMINO, Y LA DISCREPANCIA MANDA.
      if (!/FROM employer_tax_liabilities/.test(src)) {
        return falla(
          'el SUA dejó de cotejarse contra el pasivo que `acumularPasivoPatronal` apuntó al aprobar: la cifra vuelve a salir de un solo camino y nadie la confirma'
        );
      }
      if (!/bloqueantes\.length > 0/.test(src) || !/throw new ValidationError/.test(src)) {
        return falla(
          'el archivo del SUA volvió a entregarse pese a contradecir el pasivo apuntado: un descuadre que sólo se avisa es un descuadre que se sube al SUA'
        );
      }
      // Ausencia y discrepancia se distinguen: que no haya pasivo apuntado no
      // es prueba de nada y no puede bloquear, o las corridas aprobadas antes
      // del acumulador dejarían al despacho sin poder declarar.
      if (!/'sin_pasivo_que_cotejar'/.test(src)) {
        return falla(
          'el SUA dejó de distinguir «no hay contra qué cotejar» de «no cuadra»: la ausencia se nombra, no se toma por conformidad'
        );
      }

      // 3. Y HAY CONDUCTA QUE LO AFIRMA CONTRA POSTGRES.
      if (!existe(prueba)) {
        return falla(
          'no hay reproducción del archivo del SUA: este defecto no lo destapa leer, lo destapa sembrar dos meses de recibos y contar'
        );
      }
      const t = crudoDe(prueba);
      if (!/toBe\(100000\)/.test(t)) {
        return falla(
          'la reproducción dejó de exigir la cuota exacta del mes: sin una cifra afirmada, «acota» y «no acota» dan la misma prueba verde'
        );
      }

      return ok(
        'los filtros del SUA viven donde filtran, la cifra la confirma el pasivo apuntado, la discrepancia no deja salir el archivo y hay reproducción contra Postgres'
      );
    },
  },
  {
    paquete: 'E4.1',
    id: 'garnishment-vocabulary-is-the-persisted-one',
    enunciado: 'El motor de embargos lee el vocabulario que la columna documenta, y el que no sabe tratar lo lanza',
    mutantes: [
      {
        archivo: 'src/services/payroll/usa/garnishments/garnishment-engine.ts',
        de: "    case 'pension_alimenticia':\n      return 'child_support';",
        a: "      return 'creditor';",
        porque:
          'la pensión alimenticia deja de tratarse como lo que es y pierde su tope de la CCPA: era el caso que MEDIDO retenía 0 contra 500, dinero que un juez adjudicó y no llegaba',
      },
      {
        archivo: 'src/services/payroll/usa/garnishments/garnishment-engine.ts',
        de: '      throw new Error(\n        `Unknown garnishment amount_type',
        a: '      return 0; // eslint-disable-line\n      throw new Error(\n        `Unhandled amount_type',
        porque:
          'vuelve el cero silencioso: un vocabulario que el motor no entiende retiene nada en vez de negarse, que es el defecto original de T20 y su principio entero',
      },
      {
        archivo: 'src/database/migrations/075_el_embargo_que_no_retenia.sql',
        de: "  CHECK (amount_type IN ('fixed', 'percent_disposable', 'percent_gross'));",
        a: '  CHECK (true);',
        porque:
          'la columna vuelve a admitir cualquier cadena, y con ella vuelve a poder guardarse la orden que no retiene: un vocabulario sin restricción es una sugerencia',
      },
    ],
    evaluar: () => {
      // T20 punto 2 (#127). MEDIDO sobre una orden del 25 % con 2 000 de
      // ingreso disponible: `pension_alimenticia` retenía 0 y `child_support`
      // 500; `tax_levy_federal` retenía 0 y `tax_levy` 1 800. El motor leía un
      // vocabulario y la columna documentaba otro, ninguna de las dos tenía
      // CHECK, y `garnishments` no tiene un solo escritor en `src/` — así que
      // quien da de alta una orden sigue el comentario de la columna, que era
      // el camino que devolvía cero.
      const motor = 'src/services/payroll/usa/garnishments/garnishment-engine.ts';
      if (!existe(motor)) return falla('desapareció el motor de embargos');
      const src = codigoDe(motor);

      if (/amount_type = 'percentage'/.test(src)) {
        return falla('el motor vuelve a leer «percentage», que no es el vocabulario que la columna documenta: una orden guardada como manda el esquema retiene CERO (#127)');
      }
      if (!/case 'pension_alimenticia':/.test(src) || !/case 'tax_levy_federal':/.test(src)) {
        return falla('el motor dejó de tratar los tipos que la columna documenta: una pensión alimenticia o un embargo fiscal federal no retendrían nada');
      }
      if (!/Unknown garnishment amount_type/.test(src)) {
        return falla('un vocabulario desconocido vuelve a retener cero en silencio en vez de lanzar: es el principio entero de T20');
      }
      // Y la restricción, que es lo que impide que se pueda volver a guardar.
      const mig = 'src/database/migrations/075_el_embargo_que_no_retenia.sql';
      if (!existe(mig) || !/CHECK \(amount_type IN/.test(crudoDe(mig))) {
        return falla('la columna del embargo volvió a quedarse sin CHECK: un vocabulario sin restricción es una sugerencia');
      }

      return existe('tests/integration/t20-embargo-que-no-retenia.int.spec.ts')
        ? ok('el embargo se lee con el vocabulario persistido, el desconocido se lanza, la columna lo restringe y hay prueba que lo ejecuta contra la base')
        : falla('no hay prueba que EJECUTE el motor de embargos contra la base: leerlo no demuestra qué retiene');
    },
  },
  {
    paquete: 'E4.1',
    id: 'payroll-engines-fail-closed-on-missing-law',
    enunciado: 'Ante un parámetro legal ausente, los motores de nómina se niegan en vez de inventar una cifra',
    mutantes: [
      {
        archivo: 'src/services/payroll/mx/imss-calculator.ts',
        de: "const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);",
        a: "const uma = parseFloat(String(params.uma_daily || 113.14));",
        porque:
          'vuelve la UMA quemada: una corrida de un ejercicio no sembrado produce cuotas con days_worked correctos sobre una UMA de 2025, y esa cifra sale en el recibo, en el CFDI de nómina y en la línea de captura del SUA',
      },
      {
        archivo: 'src/services/payroll/usa/federal/fit-calculator.ts',
        de: 'export function validFilingStatus(',
        a: 'export function noValidaNada(',
        porque:
          'el estado civil deja de validarse y un valor fuera de catálogo vuelve a caer en una tabla vacía: FIT de 0.00 todo el año, con el patrón como retenedor omiso ante el IRS',
      },
      {
        archivo: 'src/services/payroll/common/gl-posting-service.ts',
        de: 'n(b.sit) + n(b.sdi) + n(b.local_tax)',
        a: 'n(b.sit) + n(b.sdi)',
        porque:
          'el impuesto local sale del asiento y los débitos dejan de igualar a los créditos: cualquier corrida con un recibo de local > 0 vuelve a no poder postearse («Payroll GL entry unbalanced»)',
      },
    ],
    evaluar: () => {
      // T20 puntos 1, 3 y 4 (#127). El principio es uno: fallar cerrado, como
      // ya hacía el ISR. Un cero por dato ausente es indistinguible de una
      // retención legítima, y un recibo con `days_worked` correctos y cuota
      // cero parece bueno: lo firma el despacho y viaja al SAT y al IMSS.
      const imss = 'src/services/payroll/mx/imss-calculator.ts';
      const infonavit = 'src/services/payroll/mx/infonavit-calculator.ts';
      const fit = 'src/services/payroll/usa/federal/fit-calculator.ts';
      const gl = 'src/services/payroll/common/gl-posting-service.ts';
      for (const f of [imss, infonavit, fit, gl]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      // 1. NI UMA NI TASAS QUEMADAS.
      for (const f of [imss, infonavit]) {
        const src = codigoDe(f);
        if (/\|\|\s*113\.14|\|\|\s*0\.05|\|\|\s*278\.80/.test(src)) {
          return falla(`${f} vuelve a sustituir un parámetro legal ausente por un valor quemado: la cifra inventada sale en el recibo y en la línea de captura (#127)`);
        }
      }
      if (!/requiredRates\(params, 'imss_employee'/.test(codigoDe(imss))) {
        return falla('las cuotas obreras del IMSS vuelven a leerse con «|| 0»: una tasa ausente no es una tasa de cero');
      }

      // 2. EL ESTADO CIVIL SE VALIDA.
      if (!/export function validFilingStatus\(/.test(codigoDe(fit))) {
        return falla('el filing_status del W-4 dejó de validarse: un valor fuera de catálogo cae en una tabla vacía y retiene 0.00 todo el año');
      }

      // 3. Y EL IMPUESTO LOCAL ENTRA AL ASIENTO.
      if (!/n\(b\.local_tax\)/.test(codigoDe(gl))) {
        return falla('el impuesto local volvió a quedarse fuera del asiento de nómina: la corrida no se puede postear y el mayor se queda sin la nómina entera');
      }

      return existe('tests/payroll/fallar-cerrado.spec.ts')
        ? ok('los motores se niegan ante un parámetro ausente, el estado civil se valida y el impuesto local entra al asiento')
        : falla('no hay prueba del principio de fallar cerrado: es lo único que distingue el cero por no saber del cero legítimo');
    },
  },
  {
    paquete: 'E4.1',
    id: 'employee-benefits-accrue-monthly',
    enunciado: 'El aguinaldo, las vacaciones y la prima vacacional se devengan mes a mes, no el día que se pagan',
    evaluar: () => {
      // POR QUÉ NACE (D1, issue #111). Un despacho que paga el aguinaldo en
      // diciembre y no lo provisiona durante el año publica once meses de
      // utilidad inflada y un diciembre catastrófico, y ninguno de los doce
      // estados es firmable. La NIF D-3 reconoce el beneficio a corto plazo
      // conforme el trabajador PRESTA EL SERVICIO, no cuando se paga.
      //
      // El criterio vigila las tres propiedades sin las cuales el motor sería
      // decorativo: que la ley no esté escrita dos veces, que el criterio del
      // despacho se lea del panel en vez de quemarse, y que las cuentas se
      // resuelvan por rol. La aritmética la prueban sus 55 casos unitarios; la
      // idempotencia, la prueba de integración.
      const run = codigoDe('src/services/accruals/provisions-run.ts');
      const math = codigoDe('src/services/accruals/provisions-math.ts');

      // (a) LA LEY, UNA SOLA VEZ. La tabla del art. 76 vive en finiquito-math
      // desde D1a. Una segunda copia divergiría el día que el legislador la
      // toque —y la tocó en 2023—, y entonces el finiquito y la provisión
      // pagarían distinto por el mismo derecho.
      if (!/from '\.\.\/payroll\/mx\/finiquito-math\.js'/.test(math)) {
        return falla(
          'provisions-math no importa de finiquito-math: la tabla del art. 76 o el factor de ' +
            'integración están escritos por segunda vez, y dos copias de una ley divergen'
        );
      }

      // (b) EL CRITERIO DEL DESPACHO SE PREGUNTA, NO SE DECIDE. Sobre qué
      // salario se provisiona y cuándo nace el pasivo de vacaciones son
      // bifurcaciones contables, y en esta casa van al panel con su lector.
      for (const clave of ['provision_base_salarial', 'devengo_vacaciones']) {
        if (!new RegExp(`getPolicy\\([^)]*'${clave}'`).test(run)) {
          return falla(`la provisión no lee '${clave}' del panel: la bifurcación quedó quemada en el motor`);
        }
      }

      // (c) LAS CUENTAS, POR ROL. Un código quemado ata el motor a un catálogo
      // concreto y revienta en la primera entidad que renumere.
      //
      // LOS CÓDIGOS NO SE TRANSCRIBEN AQUÍ: SE DERIVAN. La primera versión de
      // este chequeo los escribió a mano —2196 a 2199— en el MISMO commit que
      // los renumeraba a 2202-2205, así que NACIÓ MUERTO: la expresión no podía
      // acusar ningún cableado real, y como este chequeo tampoco tenía espejo
      // propio, los 168 mutantes del tablero lo daban por vivo. Es la familia
      // de T14b —«el criterio que la vigilaba se cegaba solo»—, y en este caso
      // pesa el doble porque el criterio entra al piso obligatorio: publicaba
      // «resuelve las cuentas por rol» con un tercio de la frase inverificable.
      //
      // Leyendo la lista de la que salen las cuentas, renumerar el catálogo
      // vuelve a mover el chequeo solo. Y se cae la exigencia de que
      // `debit|credit|account` aparezca en la MISMA línea: un cableado con
      // nombre español —`aguinaldo: await cuentaPorCodigo(...)`— se escapaba
      // por ahí aunque los códigos hubieran estado al día.
      const seed = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      const codigosDeProvision = [...seed.matchAll(/provision_\w+:\s*'(\d+)'/g)].map((m) => m[1]);
      if (codigosDeProvision.length === 0) {
        // FALLA CERRADO. Si el mapa cambia de forma, el chequeo se queda sin
        // nada que buscar y saldría verde sobre un motor cableado: es
        // exactamente como nació. Antes que eso, rojo.
        return falla(
          'no se derivó ni un código de provisión de account-roles-seed.ts: el chequeo de las ' +
            'cuentas por rol se quedaría sin nada que buscar, que es como nació muerto la primera vez'
        );
      }
      const quemado = codigosDeProvision.find((c) => run.includes(`'${c}'`));
      if (quemado !== undefined) {
        return falla(
          `la provisión nombra la cuenta '${quemado}' por su código: el catálogo de otra entidad ` +
            'la deja sin destino'
        );
      }

      return ok(
        'el devengo de prestaciones importa la ley de finiquito-math, lee sus dos bifurcaciones del panel ' +
          'y resuelve las cuentas por rol'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/accruals/provisions-run.ts',
        de: '  const mapa = new Map(r.rows.map((f) => [f.role, f.account_id]));',
        a: "  const mapa = new Map([...r.rows.map((f) => [f.role, f.account_id]), [ROL_AGUINALDO, '2202']]);",
        porque:
          'la cuenta del aguinaldo cableada por su código en vez de resuelta por rol: es el defecto ' +
          'que el chequeo (c) nombra, y durante todo este tramo no tuvo espejo que lo comprobara',
      },
      {
        archivo: 'src/services/xml-ingestion/account-roles-seed.ts',
        de: `  provision_aguinaldo: '2202',
  provision_vacaciones: '2203',
  provision_prima_vacacional: '2204',
  provision_prestaciones_gasto: '6116',`,
        a: `  provisionAguinaldo: '2202',
  provisionVacaciones: '2203',
  provisionPrimaVacacional: '2204',
  provisionPrestacionesGasto: '6116',`,
        porque:
          'el mapa cambia de forma y el chequeo se queda sin códigos que buscar: tiene que ponerse ' +
          'ROJO por no poder medir, no verde por no encontrar nada',
      },
      {
        archivo: 'src/services/accruals/provisions-run.ts',
        de: "  const base = await getPolicy(ctx, 'provision_base_salarial');",
        a: "  const base = { value: 'nominal' };",
        porque:
          'quema la base salarial en el motor: el despacho que provisiona sobre salario integrado deja de ' +
          'poder decirlo, y su pasivo sale corto todos los meses sin que nada lo acuse',
      },
      {
        archivo: 'src/services/accruals/provisions-math.ts',
        de: "from '../payroll/mx/finiquito-math.js'",
        a: "from './tabla-del-art-76-propia.js'",
        porque:
          'la tabla del art. 76 pasaría a estar escrita dos veces: el finiquito y la provisión pagarían ' +
          'distinto por el mismo derecho en cuanto una de las dos se actualice',
      },
    ],
  },
];
