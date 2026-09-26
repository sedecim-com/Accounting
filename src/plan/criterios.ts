import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRUEBAS_DE_CONDUCTA, correrConducta, type PruebaDeConducta } from './conducta.js';
import {
  codigoDe,
  consumidoresDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  fuentes,
  leer,
  noEvaluable,
  ok,
  RAIZ,
  rutaDe,
  sinComentarios,
  sinProsa,
} from './criteria/shared.js';
import { E0_0 } from './criteria/e0-0.js';
import { E0_1 } from './criteria/e0-1.js';
import { E0_2 } from './criteria/e0-2.js';
import { E0_3 } from './criteria/e0-3.js';
import { E1_1 } from './criteria/e1-1.js';
import { E1_2 } from './criteria/e1-2.js';
import { E1_3 } from './criteria/e1-3.js';
import { E1_4 } from './criteria/e1-4.js';
import { E2_1 } from './criteria/e2-1.js';
import { E2_2 } from './criteria/e2-2.js';
import { E3_1 } from './criteria/e3-1.js';
import { E3_2 } from './criteria/e3-2.js';

// ============================================================
// CRITERIOS DE CIERRE, EJECUTABLES
//
// El plan de cierre lleva sus criterios en prosa y NADIE los ha corrido nunca
// como conjunto. El resultado fue predecible: su tabla de estado marcaba
// resueltos paquetes que no lo estaban, y marcaba pendientes otros que sí,
// porque era un espejo escrito a mano del repositorio.
//
// Aquí los criterios son CÓDIGO. El documento los cita; esta lista los decide.
//
// DOS REGLAS QUE VIENEN DE UN ERROR CONCRETO
//
// 1. Un criterio afirma COMPORTAMIENTO, no identificadores. El cerrojo
//    antisimulación del timbrado se construyó bien, quedó mejor documentado
//    que su especificación, y falla el 100% de sus criterios escritos porque
//    su autor eligió nombres en español. Un criterio puede nombrar un archivo
//    sólo cuando el plan está PRESCRIBIENDO dónde va el código.
//
// 2. Un criterio que no se puede evaluar se declara «no evaluable» y dice por
//    qué. Nunca se aproxima: un ✅ inventado es peor que un hueco confesado,
//    porque hace que un comando imposible parezca trabajo de una hora.
// ============================================================
//
// THE INDEX. The types and helpers live in `./criteria/shared.ts` (#294) and
// are re-exported from here, so every importer of this file keeps working.
export * from './criteria/shared.js';

export const CRITERIOS: Criterio[] = [
  ...E0_0,
  ...E0_1,
  ...E0_2,
  ...E0_3,
  ...E1_1,
  ...E1_2,
  ...E1_3,
  ...E1_4,
  ...E2_1,
  ...E2_2,
  ...E3_1,
  ...E3_2,

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

  // ---- E4.2 · Trabajos y reportes ----
  {
    paquete: 'E4.2',
    id: 'posting-code-without-matview-refresh',
    enunciado: 'Postear no dispara el refresco de vistas materializadas',
    evaluar: () => {
      const s = codigoDe('src/services/accounting/posting.ts');
      return /REFRESH\s+MATERIALIZED/i.test(s)
        ? falla('cada posteo refresca las vistas: el coste crece con el volumen y bloquea')
        : ok('el refresco no vive en el camino de posteo');
    },
  },
  {
    paquete: 'E4.2',
    id: 'agent-balance-sheet-foots',
    enunciado: 'El balance que lee el agente cuadra, y publica con qué notar que no',
    evaluar: () => {
      // T14 (#101). De las tres superficies del balance —CLI, REST y la
      // herramienta del agente— sólo ésta ensamblaba su propio total: una
      // consulta, sin queryUnclosedEarnings, y
      // `total_liabilities_and_equity = pasivo + capital`. Medido sobre un
      // mayor SANO de activo 100 000 con 6 000 de resultado sin barrer,
      // publicaba 94 000.00 contra 100 000.00 — y ni un campo con el que
      // notarlo, mientras la CLI firmaba 100 000.00 sobre los mismos datos.
      const t = codigoDe('src/ai/tools/report-tools.ts');
      if (!/await getBalanceSheet\(ctx\.entityId/.test(t)) {
        return falla('la herramienta del agente volvió a ensamblar su propio balance en vez de proyectar el informe que firman la CLI y el REST');
      }
      if (!/out_of_balance:/.test(t) || !/is_balanced:/.test(t)) {
        return falla('el balance del agente dejó de publicar out_of_balance/is_balanced: el modelo no tendría con qué notar un descuadre');
      }
      // El estado de resultados suma el LIBRO, no sus propios redondeos. Con
      // el `reduce` sobre las filas ya redondeadas publicaba 0.06 donde el
      // gasto posteado es 0.0400: una cifra falsa, no un formato.
      if (!/crudoGastos\.reduce\(\(s, r\) => s\.plus\(netMovement\(r\)\)/.test(t)) {
        return falla('el estado de resultados del agente volvió a sumar filas ya redondeadas: publicaría la suma de los redondeos en vez del redondeo de la suma');
      }
      // Y el detalle a la escala que la cabecera del archivo promete desde
      // que existe, con el residuo NOMBRADO cuando las filas no suman.
      if (!/ending_balance: aEscala\(/.test(t) || !/amount_due: aEscala\(/.test(t)) {
        return falla('las filas de detalle del agente volvieron a publicarse en crudo: DECIMAL(19,4) bajo totales a dos decimales');
      }
      if (!/rounding_residual/.test(t)) {
        return falla('el residuo de redondeo dejó de nombrarse: las filas no sumarían su total y nadie diría por qué');
      }
      // La misma ceguera vivía en el sobre REST, que CALCULABA las dos claves
      // y las tiraba.
      if (!/out_of_balance: report\.out_of_balance/.test(codigoDe('src/api/rest/routes/reports.ts'))) {
        return falla('el sobre REST del balance volvió a descartar out_of_balance/is_balanced: un tablero no podría saber si el estado cuadra');
      }
      return ok('el balance del agente proyecta el informe ensamblado, publica su cuadre, y el detalle sale a escala con su residuo nombrado');
    },
    mutantes: [
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'await getBalanceSheet(ctx.entityId',
        a: 'await queryBalanceSheetRows(ctx.entityId',
        porque: 'la herramienta vuelve a calcularse su propio balance: publicaría pasivo+capital y se comería el resultado del ejercicio',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'crudoGastos.reduce((s, r) => s.plus(netMovement(r))',
        a: 'expenseRows.reduce((s, r) => s.plus(r.amount)',
        porque: 'el estado de resultados vuelve a sumar sus propios redondeos: publica 0.06 donde el libro dice 0.05',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'ending_balance: aEscala(',
        a: 'ending_balance: String(',
        porque: 'el detalle vuelve a salir en crudo a cuatro decimales bajo totales de dos, que es lo que tapaba el descuadre',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: 'out_of_balance: report.out_of_balance',
        a: 'as_of_date_bis: report.as_of_date',
        porque: 'el sobre REST vuelve a tirar el cuadre que su propio informe calcula',
      },
    ],
  },
  {
    paquete: 'E4.2',
    id: 'single-report-query-layer',
    enunciado: 'Las superficies de reportes consumen una sola capa de consulta',
    evaluar: () => {
      const cons = consumidoresDe('getTrialBalance', 'report-service.ts');
      const copias = dondeAparece(/SUM\(\s*COALESCE\(jel\.debit_amount/i, ['src'], true).filter(
        (f) => !f.includes('report-service')
      );
      if (copias.length > 0) {
        return falla(`${copias.length} copia(s) del SQL de saldos fuera de report-service: ${copias.join(', ')}`);
      }
      // T2 · VACUIDAD. «Una sola capa, consumida por 0 superficies» es el verde
      // que sale cuando no hay NADA: cero copias porque no hay código. Lo que
      // este criterio afirma es que las superficies de reportes pasan todas por
      // la misma capa, y una afirmación sobre un conjunto vacío de superficies
      // no afirma nada. Sin consumidor, la capa única es una capa muerta.
      return cons.length > 0
        ? ok(`una sola capa, consumida por ${cons.length} superficie(s)`)
        : falla(
            'la capa de consulta no tiene un solo consumidor: «una sola capa» es cierto y vacío — o ' +
              'las superficies dejaron de pasar por ella, o no queda superficie que mirar'
          );
    },
  },

  // ---- E5.1 · Madurez del agente ----
  {
    paquete: 'E5.1',
    id: 'cli-audit-baseline-ratchet',
    enunciado: 'La auditoría de consistencia corre contra el binario que se embarca, y su deuda no crece',
    evaluar: async () => {
      // `auditProgram` existía desde el principio y el programa real nunca
      // pasó por ella: vivía en un `.spec.ts` y cada prueba se construía un
      // árbol de juguete. Peor, importarla desde el spec arrastraba su suite,
      // cuyos `resetDeclarations()` vacían el registro de riesgo — así que
      // cualquier prueba que la importara auditaba un programa con cero
      // declaraciones y pasaba en el vacío.
      const { program } = await import('../cli/mnemosine.js');
      const { auditarContraLineaBase, LINEA_BASE, DEUDA_DE_LLAVES } = await import(
        '../cli/kernel/audit.js'
      );

      const { nuevas, obsoletas, heredadas } = auditarContraLineaBase(program);
      if (nuevas.length > 0) {
        return falla(
          `${nuevas.length} violación(es) que no están en la línea base — p. ej. ` +
            `${nuevas[0].command}: ${nuevas[0].detail}`
        );
      }
      if (obsoletas.length > 0) {
        return falla(
          `${obsoletas.length} entrada(s) de la línea base ya no se violan y siguen ahí: una lista ` +
            'que no encoge deja de ser deuda registrada y se vuelve un permiso permanente'
        );
      }
      // La deuda congelada son ahora DOS listas: LINEA_BASE (40 violaciones de
      // vocabulario y contrato) y DEUDA_DE_LLAVES (las hojas que aceptan
      // --idempotency-key y no la honran, que R11 acusa desde T3). Sumarlas
      // aquí es lo que hace que el número que se imprime siga siendo el
      // denominador de verdad.
      return ok(
        `sin violaciones nuevas; ${heredadas} de ${LINEA_BASE.length + DEUDA_DE_LLAVES.length} heredadas siguen vivas`
      );
    },
  },
  {
    paquete: 'E5.1',
    id: 'output-flag-writes-complete-output',
    enunciado:
      '`-o` entrega un archivo con la salida COMPLETA del comando: todo dato sale por una sola puerta',
    evaluar: async () => {
      // `-o/--output` es CONTRATO con guiones y con el agente, y mentía de
      // tres formas medidas sobre el binario: `cfdi list --fields -o f` salía
      // 0 sin crear `f`; una tabla de cero filas tampoco lo creaba; y
      // `cfdi show -o f` dejaba en `f` sólo los conceptos, porque el segundo
      // `render` truncaba al primero.
      //
      // ESTE CRITERIO NO CUENTA ESCRITURAS. Un censo de `out.write(` mide la
      // ortografía de un archivo —se satisface aliaseando el flujo, o
      // escribiendo `process.stdout`— y no afirma nada sobre `-o`. Lo que se
      // mira aquí es el SEAM que hace imposible el escape, y luego la
      // promesa, ejecutándola:
      //
      //   · quien compone el texto no recibe ningún flujo (no tiene a dónde
      //     escribir) y devuelve un tipo TOTAL, así que una rama futura
      //     —`--summary`, `--count`— que se olvide de producir su texto es un
      //     error de `tsc`, no un archivo que no aparece;
      //   · `render` no escribe el dato: se lo entrega a la puerta;
      //   · y con `-o` el archivo existe y contiene las DOS salidas de un
      //     comando que rinde dos veces.
      const codigo = sinComentarios(crudoDe('src', 'cli', 'kernel', 'output.ts'));

      const firma = /function compose\(([^)]*)\)\s*:\s*Composed\s*\{/.exec(codigo);
      if (!firma) {
        return falla(
          'el compositor de output.ts ya no es `compose(...): Composed`: o desapareció, o su ' +
            'tipo de retorno dejó de ser total — y con un retorno opcional el compilador deja ' +
            'de exigirle a cada rama que produzca su texto, que es lo único que impide que la ' +
            'siguiente nazca sin archivo'
        );
      }
      if (/WriteStream/.test(firma[1])) {
        return falla(
          'el compositor volvió a recibir un flujo de escritura: con un `out` en el alcance, ' +
            'cualquier rama puede imprimir por su cuenta y `-o` vuelve a no crear el archivo'
        );
      }

      const cuerpoRender = /export function render\([\s\S]*?\n\}/.exec(codigo)?.[0] ?? '';
      if (!/\bemit\(\s*data\s*,\s*opts\s*,\s*out\s*\)/.test(cuerpoRender)) {
        return falla(
          '`render` ya no entrega su texto a la puerta que conoce `--output`: el dato se escribe ' +
            'en otro sitio, que es exactamente como se perdían la cabecera de `cfdi show` y el ' +
            'archivo de `--fields`'
        );
      }

      // Y ahora la promesa, EJECUTADA. Se mide por TAMAÑO y no leyendo el
      // archivo, y no es un rodeo: el archivo tiene que pesar exactamente lo
      // que los mismos renders habrían impreso por stdout, que es una
      // afirmación más fuerte que «contiene tal palabra» — la cabecera de
      // `cfdi show` se perdía entera y una palabra suelta la habría dado por
      // buena. (Además, `fs.readFileSync` aquí subiría el conteo que vigila
      // el meta-criterio del seam, y ése mide bien: ninguna lectura de este
      // archivo debe rodear `leer()`.)
      const { render, resetOutputTargets } = await import('../cli/kernel/output.js');
      const impreso: string[] = [];
      const espia = {
        write: (t: string) => {
          impreso.push(t);
          return true;
        },
        isTTY: false,
      } as unknown as NodeJS.WriteStream;
      const callado = { write: () => true, isTTY: false } as unknown as NodeJS.WriteStream;
      const cabecera = [{ uuid: 'AAAA', total: '1160.00' }];
      const conceptos = [{ linea: 1, importe: '1000.00' }];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promesa-de-archivo-'));
      try {
        // Lo que este comando IMPRIME cuando nadie pidió archivo.
        resetOutputTargets();
        render(cabecera, { stdout: espia, stderr: callado });
        render(conceptos, { stdout: espia, stderr: callado });
        const esperado = Buffer.byteLength(impreso.join(''), 'utf8');

        const destino = path.join(dir, 'salida.txt');
        resetOutputTargets();
        render(cabecera, { output: destino, stdout: callado, stderr: callado });
        render(conceptos, { output: destino, stdout: callado, stderr: callado });
        render([], { output: destino, stdout: callado, stderr: callado });
        if (!fs.existsSync(destino)) return falla('`-o` salió 0 sin crear el archivo que prometió');
        const pesa = fs.statSync(destino).size;
        if (pesa !== esperado) {
          return falla(
            `el archivo de \`-o\` pesa ${pesa} byte(s) y la salida del comando son ${esperado}: ` +
              'no contiene lo que el comando habría impreso. Con menos, una tabla borró a la ' +
              'anterior — es el defecto con el que `cfdi show -o` devolvía los conceptos sin el ' +
              'comprobante; con más, se está acumulando algo que no es de esta invocación'
          );
        }

        const vacio = path.join(dir, 'vacio.txt');
        resetOutputTargets();
        render([], { output: vacio, stdout: callado, stderr: callado });
        if (!fs.existsSync(vacio)) {
          return falla(
            'cero filas con `-o` no creó archivo: cero filas es un RESULTADO, y `-o` prometió un ' +
              'archivo, no un contenido'
          );
        }

        const censo = path.join(dir, 'campos.txt');
        resetOutputTargets();
        render(cabecera, { output: censo, fields: true, stdout: callado, stderr: callado });
        if (!fs.existsSync(censo)) {
          return falla('`--fields` a secas con `-o` salió 0 sin crear el archivo');
        }
        return ok(
          `el compositor no tiene flujo al que escribir, \`render\` pasa por la puerta, y dos ` +
            `renders con el mismo \`-o\` dejan los ${esperado} byte(s) completos en el archivo`
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    mutantes: [
      {
        archivo: 'src/cli/kernel/output.ts',
        de: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed {',
        a: 'function compose(rows: Row[], opts: RenderOptions, p: Palette, out: NodeJS.WriteStream): Composed {',
        porque:
          'firma-que-recupera-el-flujo: devolverle un `out` al compositor reabre la puerta de atrás ' +
          'por la que `--fields` y la tabla vacía escribían sin pasar por `--output`',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed {',
        a: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed | void {',
        porque:
          'retorno-que-deja-de-ser-total: con `| void` el compilador ya no rechaza la rama futura ' +
          'que se olvida de producir su texto, y el guardián deja de ser tsc para volver a ser la suerte',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '  emit(data, opts, out);',
        a: '  out.write(data);',
        porque:
          'puerta-esquivada: escribir el dato en `render` en vez de entregarlo a `emit` es el defecto ' +
          'original entero — el archivo de `-o` deja de existir aunque el comando salga 0',
      },
    ],
  },
  {
    paquete: 'E5.1',
    id: 'idempotency-key-honored-and-scoped',
    enunciado:
      'R11 comprueba que la llave se HONRE, y todo ámbito declarado llega de verdad al almacén',
    evaluar: async () => {
      // R11 COMPROBABA SU PROPIO EFECTO SECUNDARIO. Verificaba que un comando
      // de riesgo llevara --dry-run, --yes e --idempotency-key, y
      // `declareRisk` se las inyecta él mismo unas líneas antes: sobre el
      // binario embarcado daba CERO violaciones en 36 hojas graves. Mientras
      // tanto la promesa textual de la bandera —«a retry with the same key
      // and payload returns the recorded result»— la cumplían 15.
      //
      // Este criterio vigila las DOS mitades de la reparación, y ninguna se
      // puede satisfacer inyectando una bandera:
      //   (a) la regla nombra la acusación, así que puede fallar;
      //   (b) todo ámbito DECLARADO viaja hasta una llamada al almacén.
      // (a) SE MIDE **Y** SE ANCLA, y las dos mitades hacen falta.
      //
      //     El ancla de texto sola no medía nada: con el literal en su sitio,
      //     la acusación podía dejar de emitirse y el criterio seguía verde —
      //     que habría sido, un piso más abajo, el MISMO error que denuncia.
      //     Pero la medición sola tampoco basta: el seam del arnés gobierna la
      //     LECTURA DE TEXTO, no los módulos importados, así que un criterio
      //     que sólo hace `await import(...)` es inmune a su propio espejo y
      //     sus mutantes sobreviven. Juntas: la medición caza el silencio, el
      //     ancla deja que el arnés muerda.
      const audit = crudoDe('src/cli/kernel/audit.ts');
      if (!audit.includes("rule: 'R11 llave aceptada sin honrar',")) {
        return falla(
          'R11 volvió a comprobar sólo las banderas que declareRisk inyecta: una regla que ' +
            'verifica su propio efecto secundario no puede fallar'
        );
      }
      // Y AHORA LA MEDICIÓN. La primera versión de este criterio
      //     comprobaba `audit.includes("rule: '…'")` sobre el fuente, y eso
      //     habría sido, un piso más abajo, el MISMO error que denuncia:
      //     verificar la existencia de un literal en vez de la conducta. Con
      //     el literal en su sitio, la acusación podía dejar de emitirse y el
      //     criterio seguía verde. Aquí se corre el auditor sobre el binario
      //     de verdad y se CUENTAN las acusaciones.
      const { program } = await import('../cli/mnemosine.js');
      const { auditProgram, esDeudaDeLlave, DEUDA_DE_LLAVES } = await import('../cli/kernel/audit.js');
      const acusadas = auditProgram(program).filter(esDeudaDeLlave);
      if (acusadas.length === 0) {
        return falla(
          'R11 no acusa a ninguna hoja: o volvió a comprobar sólo las banderas que declareRisk ' +
            'inyecta —una regla que verifica su propio efecto secundario no puede fallar— o dejó ' +
            'de emitirse con su literal intacto'
        );
      }
      if (acusadas.length !== DEUDA_DE_LLAVES.length) {
        return falla(
          `R11 acusa a ${acusadas.length} hojas y la deuda declarada tiene ${DEUDA_DE_LLAVES.length}: ` +
            'la lista sólo puede ENCOGER, y encoge borrando el renglón de la hoja que se cablea, ' +
            'nunca dejando de acusar'
        );
      }

      // El fuente del CLI SIN comentarios y SIN las declaraciones: si no, la
      // propia `llave: { scope: 'X' }` se encontraría a sí misma y el
      // criterio diría que el ámbito está cableado por haberlo escrito.
      const cli = fuentes('src/cli')
        .map((f) => sinComentarios(leer(f)))
        .join('\n')
        .replace(/llave:\s*\{\s*scope:\s*'[^']*'\s*\}/g, '');
      const declarados = [
        ...sinComentarios(
          fuentes('src/cli')
            .map((f) => leer(f))
            .join('\n')
        ).matchAll(/llave:\s*\{\s*scope:\s*'([^']*)'\s*\}/g),
      ].map((m) => m[1]);
      if (declarados.length < 15) {
        return falla(
          `sólo ${declarados.length} hoja(s) declaran el ámbito de su llave: el censo medido eran 19`
        );
      }
      // EL ÁMBITO PUEDE VIAJAR POR UNA CONSTANTE, no sólo como literal en la
      // llamada: `receipt record` lo hace así porque lo usan DOS sitios —la
      // consulta temprana de la llave y su consumo—, y dos literales que puedan
      // divergir serían dos deduplicaciones distintas con el mismo nombre. Lo
      // que este cruce defiende es que la palabra declarada ESTÉ en el fuente
      // del manejador, no la forma sintáctica con que llega.
      const huerfanos = declarados.filter((a) => !cli.includes(`'${a}'`));
      if (huerfanos.length > 0) {
        return falla(
          `${huerfanos.length} ámbito(s) declarados que ninguna llamada a conLlave usa ` +
            `(${huerfanos.join(', ')}): la declaración promete una deduplicación que el manejador no hace`
        );
      }
      // Y las dos que duplicaban DINERO, por su nombre: son las que el issue
      // #90 pone como ejemplo y las que se reprodujeron contra Postgres.
      const dinero = ['receipt record', 'payment create'].filter((a) => !declarados.includes(a));
      if (dinero.length > 0) {
        return falla(`${dinero.join(' y ')} volvió a aceptar la llave sin honrarla`);
      }
      return ok(
        `${declarados.length} ámbito(s) declarados, todos entregados al almacén; ` +
          'R11 acusa a las que no la honran'
      );
    },
    mutantes: [
      {
        archivo: 'src/cli/kernel/audit.ts',
        de: "rule: 'R11 llave aceptada sin honrar',",
        a: "rule: 'R11 risk flags',",
        porque:
          'la acusación se disuelve dentro de la regla tautológica: R11 vuelve a decir sólo lo que ' +
          'declareRisk acaba de inyectar y deja de poder fallar',
      },
      {
        archivo: 'src/cli/receipt-command.ts',
        de: "const AMBITO_DE_COBRO = 'receipt record';",
        a: "const AMBITO_DE_COBRO = 'cobro';",
        porque:
          'el manejador consuma la llave bajo OTRO ámbito que el declarado — el escape de ' +
          'firma-como-llamada: la declaración sigue escrita y la deduplicación de `receipt record` ' +
          'deja de existir para quien la lea',
      },
      {
        archivo: 'src/cli/payment-command.ts',
        de: "          scope: 'payment create',",
        a: "          scope: 'entry post',",
        porque:
          'dos hojas bajo el mismo ámbito se deduplican ENTRE SÍ (la unicidad de idempotency_keys ' +
          'es por tenant+scope+clave), y el ámbito declarado por `payment create` deja de tener ' +
          'llamada propia',
      },
    ],
  },
  {
    paquete: 'E5.1',
    id: 'every-cli-leaf-declares-risk',
    enunciado: 'Toda hoja del CLI declara su riesgo, así que hay algo sobre lo que aplicar la compuerta',
    evaluar: async () => {
      // Se mide sobre el PROGRAMA EMBARCADO, no sobre un árbol de juguete.
      // 49 de 106 hojas no declaraban nada —entre ellas las que postean al
      // mayor y la que ejecuta contra el sistema del cliente— y por eso la
      // regla R11 del auditor devolvía cero violaciones: no tenía sobre qué
      // correr. Un verde por no tener nada que mirar es el defecto que este
      // sprint persigue, y aquí estaba en el instrumento mismo.
      const { program } = await import('../cli/mnemosine.js');
      const { riskOf } = await import('../cli/kernel/risk.js');
      const { hojasDe } = await import('../cli/kernel/riesgos-retrofit.js');

      const hojas = hojasDe(program);
      if (hojas.length < 80) {
        return noEvaluable(`sólo se leyeron ${hojas.length} hojas: el árbol no se montó entero`);
      }
      const sin = hojas.filter((h) => !riskOf(h.cmd)).map((h) => h.ruta);
      if (sin.length > 0) {
        return falla(
          `${sin.length} de ${hojas.length} hojas sin declarar (${sin.slice(0, 4).join(', ')}` +
            `${sin.length > 4 ? ', …' : ''}): a lo que no declara no se le aplica ninguna compuerta`
        );
      }
      // Y la garantía que sostiene el diseño del asistente.
      const agenteEnGrave = hojas.filter((h) => {
        const r = riskOf(h.cmd)!;
        return r.agentAllowed && (r.risk === 'irreversible' || r.risk === 'externo');
      });
      return agenteEnGrave.length === 0
        ? ok(`las ${hojas.length} hojas declaran, y ninguna grave es invocable por el agente`)
        : falla(
            `${agenteEnGrave.map((h) => h.ruta).join(', ')}: el agente puede invocar algo irreversible o externo`
          );
    },
  },
  {
    paquete: 'E5.1',
    id: 'agent-tools-from-risk-registry',
    enunciado: 'Las herramientas del agente se derivan del registro de riesgo del CLI',
    evaluar: () => {
      // FALSO VERDE CORREGIDO. La versión anterior contaba cualquier mención
      // de `allDeclarations` fuera de risk.ts como «consumidor», y eso
      // incluía el re-export del barril (kernel/index.ts) — un archivo que no
      // consume nada, sólo reexporta. El tablero decía «el puente existe»
      // mientras las herramientas del agente seguían escritas a mano. Un
      // criterio cuyo verde puede producirlo un `export {...} from` no mide
      // un puente: mide que el símbolo exista, que ya lo mide el compilador.
      //
      // Consumidor de verdad = un archivo FUERA del núcleo del CLI que nombre
      // el símbolo. El puente será real cuando src/ai derive su superficie de
      // herramientas del registro; hasta entonces, rojo honesto.
      const cons = consumidoresDe('allDeclarations', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      return cons.length > 0
        ? ok(`el puente existe: ${cons.join(', ')}`)
        : falla(
            'allDeclarations no tiene consumidor fuera del núcleo (el re-export del barril no ' +
              'consume nada): las herramientas del agente siguen escritas a mano en vez de ' +
              'derivarse del registro de riesgo. La sesión desatendida ya corre con superficie ' +
              'nombrada (S0.3), pero esa lista también es a mano — el puente que las derive es ' +
              'una aspiración, y este rojo es su registro'
          );
    },
  },
  {
    paquete: 'E5.1',
    id: 'unattended-named-tool-surface',
    enunciado: 'La corrida desatendida corre con una superficie nombrada, no con «todas»',
    evaluar: () => {
      // La sesión desatendida recibía todas las herramientas porque la
      // fábrica ni siquiera admitía recorte. Hoy pasa una lista EXPLÍCITA
      // (tools/superficie.ts) y buildTools lanza ante nombres que no existen:
      // una herramienta nueva nace excluida de lo desatendido hasta que
      // alguien la añada a la lista, y un renombre rompe en el arranque en
      // vez de encoger la superficie en silencio.
      if (!existe('src/ai/tools/superficie.ts')) {
        return falla('no existe la superficie nombrada: la desatendida vuelve a recibir todo por omisión');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      // La expresión admite el ternario de S0.6: con --live viaja la
      // superficie completa y sin ella la variante SANDBOX (misma lista menos
      // las dos lecturas externas). Lo que se afirma es que la opción
      // `herramientas` se alimenta de la lista NOMBRADA, nunca de una omisión.
      if (!/herramientas:[^\n]*SUPERFICIE_DESATENDIDA/.test(cli)) {
        return falla(
          'makeRunAgentTurn no pasa SUPERFICIE_DESATENDIDA: la sesión desatendida recibe la ' +
            'superficie completa por omisión, y una herramienta futura entraría sin que nadie lo decida'
        );
      }
      const fabrica = codigoDe('src/ai/tools/index.ts');
      return /permitidas/.test(fabrica) && /throw new Error/.test(fabrica)
        ? ok('la desatendida corre con lista explícita, y un nombre fantasma rompe en el arranque')
        : falla('buildTools no valida la lista: un nombre renombrado filtraría en silencio');
    },
  },
  {
    paquete: 'E5.1',
    id: 'dangerous-commands-gated-and-keyed',
    enunciado: 'Los graves declaran junto a su registro, con la compuerta cableada y la llave guardada',
    evaluar: () => {
      // S0.6, tres afirmaciones mecánicas sobre el mismo borde.
      //
      // 1) La tabla de retrofit no declara ningún grave. Un irreversible o
      //    externo declarado por tabla es un manejador que nadie cableó: el
      //    preAction de la tabla sólo sabía rechazar --dry-run/--live en voz
      //    alta, nunca honrarlas. Una fila grave nueva sería ese retroceso.
      const tabla = codigoDe('src/cli/kernel/riesgos-retrofit.ts');
      if (/risk:\s*'(irreversible|externo)'/.test(tabla)) {
        return falla(
          'la tabla de retrofit volvió a declarar un grave: su manejador no honra --dry-run/--live — declara junto al registro y cablea gateMutation'
        );
      }
      // 2) La compuerta tiene consumidores reales fuera del kernel: los ocho
      //    graves migrados más las familias que ya nacieron cableadas.
      const consumidores = consumidoresDe('gateMutation', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      if (consumidores.length < 8) {
        return falla(
          `gateMutation se consume en ${consumidores.length} archivo(s) fuera del kernel; con los ocho graves cableados deben ser al menos 8`
        );
      }
      // 3) La llave de idempotencia se guarda de verdad: hay quien escribe
      //    idempotency_keys y más de un comando pasa por el almacén. Sin
      //    esto, --idempotency-key vuelve a ser un aviso que promete de más.
      const escritores = dondeAparece(/INSERT\s+INTO\s+idempotency_keys/i, ['src'], true);
      if (escritores.length === 0) {
        return falla('nadie escribe idempotency_keys: la bandera vuelve a ser un aviso sin almacén');
      }
      const usos = consumidoresDe('conLlave', 'idempotency-store.ts');
      return usos.length >= 3
        ? ok(
            `graves fuera de la tabla; compuerta consumida en ${consumidores.length} archivos; llave guardada (${escritores[0]}) y consumida en ${usos.length}`
          )
        : falla(
            `conLlave se consume en ${usos.length} archivo(s); entry post/reverse/void, close y onboard exigen al menos 3`
          );
    },
  },
  {
    paquete: 'E5.1',
    id: 'amounts-survive-context-compaction',
    enunciado: 'Los importes sobreviven a la compactación por construcción',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-c): el backstop determinista de la
      // compactación cubría UUIDs, RFCs y folios, y los IMPORTES —la carga
      // útil de un agente contable— quedaban «protegidos por instrucción
      // solamente», según confesaba el propio comentario del módulo. Verde
      // exige que MONTO_RE exista y esté en la lista del extractor.
      const c = codigoDe('src/ai/compaction.ts');
      if (!/MONTO_RE/.test(c)) {
        return falla('no existe MONTO_RE: los importes vuelven a depender de que el modelo se porte bien');
      }
      return /\[UUID_RE,\s*RFC_RE,\s*FOLIO_RE,\s*MONTO_RE\]/.test(c)
        ? ok('el extractor incluye importes: lo que el resumen tire, el backstop lo re-adjunta')
        : falla('MONTO_RE existe pero el extractor no lo usa: es un regex decorativo');
    },
  },
  {
    paquete: 'E5.1',
    id: 'resumed-session-rehydrates-history',
    enunciado: 'El «--continue» rehidrata el contexto que promete',
    evaluar: () => {
      // ROJO HONESTO (S1, hueco confesado de E5.1-b): la propia opción lo
      // dice — «transcript continuity; the model context starts fresh». Un
      // usuario que retoma su sesión espera que el agente recuerde la
      // conversación, no sólo que el transcript se anexe. Verde exige que
      // las opciones de sesión acepten un historial y que el camino de
      // --continue lo alimente desde getSessionMessages.
      const tipos = codigoDe('src/ai/providers/index.ts');
      const cli = codigoDe('src/cli/mnemosine.ts');
      if (!/historial/.test(tipos)) {
        return falla(
          'CreateLlmSessionOptions no acepta historial: --continue anexa transcript pero el ' +
            'modelo arranca en blanco — la rehidratación es trabajo de la familia del agente'
        );
      }
      return /historial/.test(cli)
        ? ok('el camino de --continue alimenta el historial de la sesión')
        : falla('las opciones aceptan historial y el CLI no lo alimenta');
    },
  },
  {
    paquete: 'E5.1',
    id: 'model-prices-effective-date-shown',
    enunciado: 'Los precios del ledger declaran su vigencia, y el reporte la muestra',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-f): la tabla de precios llevaba su fecha
      // de corte en un COMENTARIO. Un costo estimado con precios de hace un
      // año se lee como costo de hoy si nadie lo dice en la salida.
      const p = codigoDe('src/ai/providers/prices.ts');
      if (!/PRECIOS_VIGENTES_A\s*=\s*'\d{4}-\d{2}-\d{2}'/.test(p)) {
        return falla('la fecha de corte volvió a ser prosa: PRECIOS_VIGENTES_A no existe como dato');
      }
      return /PRECIOS_VIGENTES_A/.test(codigoDe('src/cli/usage-command.ts'))
        ? ok('la vigencia es un dato y cada reporte de uso la muestra')
        : falla('la fecha existe y el reporte de uso no la enseña');
    },
  },
  {
    paquete: 'E5.1',
    id: 'agent-tools-propose-never-execute',
    enunciado: 'Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera',
    mutantes: [
      {
        archivo: 'src/ai/tools/ledger-tools.ts',
        de: 'envolverDatosDeTerceros(',
        a: 'envolverDatosDeTerceros(postJournalEntry, ',
        porque: 'una herramienta que NOMBRA una puerta de dinero debe enrojecer, aunque no la llame (la lección del import)',
      },
    ],
    evaluar: () => {
      // ESTE CRITERIO ESTABA EN ROJO POR UNA AFIRMACIÓN FALSA.
      //
      // Decía que `makeRunAgentTurn` construye la sesión sin recortar
      // herramientas y concluía que «un modelo que ignora el prompt escribe de
      // verdad». Lo primero es cierto; lo segundo no, y se comprueba mirando
      // la superficie: ninguna herramienta emite INSERT, UPDATE ni DELETE, la
      // familia del mayor sólo tiene SELECT, y lo que sí escribe lo hace en
      // `ai_drafts`, `ai_questions` o la bandeja de salida — que ENCOLA, no
      // ejecuta. La garantía «el agente propone y un humano dispone» se cumple
      // por construcción de las herramientas, no por una frase del prompt.
      //
      // Un rojo falso en el tablero que ordena los sprints es la misma
      // patología que el sprint persigue, cometida sobre el instrumento: se
      // convierte en paisaje, y el día que haya un rojo verdadero nadie lo
      // distinguirá. Así que el criterio pasa a afirmar la propiedad que de
      // verdad sostiene el diseño, y es falsable: una herramienta nueva que
      // llame al motor de posteo lo pone en rojo.
      const dir = 'src/ai/tools';
      const archivos = fuentes(dir);
      if (archivos.length === 0) return noEvaluable('no existe la superficie de herramientas');

      // Tres cercas, porque la auditoría demostró que una sola se salta.
      //
      // 1. NOMBRES prohibidos, por identificador y no por llamada: la
      //    primera versión exigía `nombre(` y un `import { x as y }` la
      //    evadía. Una herramienta no tiene razón legítima ni para NOMBRAR
      //    estos símbolos. La lista incluye las puertas de dinero creadas en
      //    este mismo sprint — la versión anterior vigilaba las viejas y era
      //    ciega a ligarPagoREP y procesarREP, recién nacidas.
      const PROHIBIDOS = [
        'postJournalEntry',
        'createJournalEntry',
        'recordVendorPayment',
        'recordCustomerPayment',
        'issueInvoice',
        'approveBill',
        'approveDraft',
        'hardClosePeriod',
        'commitPeriod',
        'executeExternalOp',
        'ligarPagoREP',
        'procesarREP',
        'processToAccounting',
        'createBankTransaction',
      ];
      // 2. MÓDULOS prohibidos: llamar a un servicio que a su vez postea es la
      //    evasión transitiva. Los módulos de dinero no se importan desde las
      //    herramientas, con ningún nombre.
      const MODULOS_PROHIBIDOS =
        /from\s+'[^']*(accounting\/posting|payments\/payment-service|xml-ingestion\/rep-linkage|accounting\/period-close|xml-ingestion\/pre-registration-service)/;
      const culpables: string[] = [];
      for (const f of archivos) {
        const codigo = sinComentarios(leer(f));
        const rel = path.relative(rutaDe(), f);
        for (const nombre of PROHIBIDOS) {
          if (new RegExp(`\\b${nombre}\\b`).test(codigo)) culpables.push(`${rel} → ${nombre}`);
        }
        if (MODULOS_PROHIBIDOS.test(codigo)) {
          culpables.push(`${rel} → importa un módulo de dinero`);
        }
        // 3. SQL de escritura directo, con el UPDATE multilínea incluido: el
        //    regex viejo exigía `UPDATE x SET` en una línea y una plantilla
        //    con salto de línea pasaba.
        if (/INSERT\s+INTO|UPDATE[\s\S]{0,80}?\bSET\b|DELETE\s+FROM|TRUNCATE\s|MERGE\s+INTO/i.test(codigo)) {
          culpables.push(`${rel} → SQL de escritura directo`);
        }
      }
      return culpables.length === 0
        ? ok(
            `${archivos.length} archivos de herramientas: ninguno postea, cobra, paga, timbra ni ` +
              'ejecuta hacia fuera; lo que escriben va a borradores, preguntas o la bandeja de salida'
          )
        : falla(
            `una herramienta del agente alcanza un camino que no debería: ${culpables.join(', ')}`
          );
    },
  },

  {
    paquete: 'E5.1',
    id: 'cfdi-classifier-golden-set',
    enunciado: 'El clasificador tiene vara de medir: golden set con esperado y arnés fijado',
    evaluar: () => {
      // A1: «medir antes de soltar» era doctrina sin instrumento — la brecha
      // madre de la auditoría integral. La vara: un corpus con respuesta
      // (tests/golden/cfdi, pares xml + esperado.json que incluyen los casos
      // donde lo correcto es PREGUNTAR) y un arnés que corre el MISMO camino
      // que la ingesta —ingestCfdiFiles con sus compuertas— contra un
      // proveedor FIJADO: createLlmSession directo, sin cadena de failover
      // (un eval que cambia de modelo a mitad de corrida no mide nada).
      const dir = rutaDe('tests/golden/cfdi');
      if (!fs.existsSync(dir)) return falla('el golden set no existe: no hay contra qué medir al clasificador');
      const archivos = fs.readdirSync(dir);
      const xmls = archivos.filter((a) => a.endsWith('.xml'));
      const huerfanos = xmls.filter((a) => !archivos.includes(a.replace(/\.xml$/, '.esperado.json')));
      if (xmls.length < 9 || huerfanos.length > 0) {
        return falla(`el corpus perdió casos o respuestas (${xmls.length} xml, sin esperado: ${huerfanos.join(', ') || 'ninguno'})`);
      }
      const arnes = codigoDe('scripts/eval-clasificador.ts');
      if (!/createLlmSession\(/.test(arnes) || /createLlmSessionWithFailover/.test(arnes)) {
        return falla('el arnés dejó de fijar proveedor: con cadena de failover la corrida no es comparable');
      }
      if (!/ingestCfdiFiles\(/.test(arnes)) {
        return falla('el arnés ya no corre el camino real de la ingesta: mediría un clasificador que no existe');
      }
      if (!/clasificador\.jsonl/.test(arnes) || !/agregarPuntuaciones\(/.test(arnes)) {
        return falla('el arnés perdió la bitácora o la puntuación: sin «contra la corrida anterior» no hay tendencia');
      }
      // Forma de LLAMADA (marca('abstencion', …)), no el símbolo: la unión de
      // tipos también dice 'abstencion' y un regex laxo bendice al mutante
      // que renombra la marcación real — el primo del import (AUD-6).
      return /marca\(\s*\n?\s*'abstencion'/.test(codigoDe('src/ai/eval/puntuacion.ts'))
        ? ok(`${xmls.length} casos con esperado, arnés por el camino real, proveedor fijado y bitácora comparable`)
        : falla('la puntuación perdió la clase abstención: dejaría de medirse la humildad de preguntar');
    },
  },
  {
    paquete: 'E5.1',
    id: 'confidence-calibration-buckets-with-delta',
    enunciado: 'La calibración se lee del rastro: ai stats por bucket, con delta',
    evaluar: () => {
      // A2: la confianza que el modelo reporta contra lo que el despacho
      // decidió, bucket por bucket — y el DELTA que exhibe el exceso de
      // confianza. El destino se reconstruye del rastro de atribución que
      // los caminos de aprobación dejan a propósito (la nota del auto-post,
      // el reviewed_by 'policy:'), no de una columna que no existe.
      const svc = codigoDe('src/ai/stats-service.ts');
      // Conteos, no presencia: la nota del auto-post aparece en TRES brazos
      // del CASE (el filtro de auto y los dos NOT LIKE que separan política
      // y humano) y el prefijo 'policy:' en DOS. Mutar uno deja los demás y
      // un chequeo de presencia lo bendice — la lección de R1 (la resta
      // JSONB contada una vez, existiendo en dos funciones).
      const notasAuto = (svc.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefijosPolitica = (svc.match(/'policy:%'/g) ?? []).length;
      if (!/FROM ai_drafts/.test(svc) || notasAuto < 3 || prefijosPolitica < 2) {
        return falla(
          `las estadísticas dejaron de leer el rastro de atribución completo (nota auto ×${notasAuto}, prefijo policy ×${prefijosPolitica}): auto, política y humano se confundirían`
        );
      }
      if (!/media\.minus\(tasa\)/.test(svc)) {
        return falla('el delta confianza-vs-realidad desapareció: los buckets sin delta son un conteo, no una calibración');
      }
      const cmd = codigoDe('src/cli/ai-command.ts');
      if (!/declareRisk\(stats,\s*\{\s*risk:\s*'lectura',\s*agent:\s*true/.test(cmd)) {
        return falla('ai stats dejó de ser lectura abierta al agente: medirse a sí mismo es el único privilegio que debe tener');
      }
      return /registerAiCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'))
        ? ok('ai stats registrado: buckets sobre ai_drafts, atribución por rastro y delta a la vista')
        : falla('registerAiCommand no está en el binario: la calibración existiría sin superficie');
    },
  },
  {
    paquete: 'E5.1',
    id: 'agent-work-leaves-measurable-trace',
    enunciado: 'Lo que el agente hace deja rastro medible: duración, corridas y eventos',
    evaluar: () => {
      // A2: las métricas que faltaban. duration_ms en el ledger de uso (los
      // DOS runners miden alrededor de su llamada), los counts de la ingesta
      // persistidos por corrida (con consumo, para que costo-por-borrador
      // sea una división), y sospecha/nudge/failover como filas — el delito
      // menor deja rastro ANTES de discutir la autonomía mayor.
      const m = 'src/database/migrations/044_el_agente_medible.sql';
      if (!existe(m)) return falla('la 044 desapareció: sin tablas no hay rastro');
      const sql = crudoDe(m);
      if (!/ADD COLUMN duration_ms/.test(sql) || !/CREATE TABLE ai_ingest_runs/.test(sql) || !/CREATE TABLE ai_agent_events/.test(sql)) {
        return falla('la 044 perdió una de sus tres piezas (duration_ms, ai_ingest_runs, ai_agent_events)');
      }
      // Conteo por archivo, no presencia: el agente emite en DOS sitios
      // (bucle del runner y summarize) y el compat en TRES (summarize,
      // no-stream, stream) — mutar el sitio principal dejando el secundario
      // pasa un chequeo de presencia. Tercera aparición de la lección del
      // conteo en esta misma corrida.
      // Sólo Date.now() cuenta como medición: una alternativa `durationMs`
      // casaba la FIRMA de emitUsage(usage, durationMs?) y la declaración
      // pasaba por sitio medido — el regex mordiéndose la cola.
      const emisionesMedidas = (f: string): number =>
        (codigoDe(f).match(/emitUsage\([^)]*,\s*Date\.now\(\)/g) ?? []).length;
      const enAgente = emisionesMedidas('src/ai/agent.ts');
      const enCompat = emisionesMedidas('src/ai/providers/openai-compat.ts');
      if (enAgente < 2 || enCompat < 3) {
        return falla(
          `un runner dejó de medir alguna de sus llamadas (agente ${enAgente}/2, compat ${enCompat}/3)`
        );
      }
      if (!/duration_ms/.test(codigoDe('src/ai/usage-ledger.ts'))) {
        return falla('el ledger de uso dejó de persistir la duración que los runners miden');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      // El criterio afirma la CONDUCTA —que la corrida quede registrada—, no
      // el nombre de la función que la registra. Afirmaba
      // `registrarCorridaIngesta(ctx` y se puso rojo el día que A7·3 partió
      // esa función en abrir/cerrar para que la fila naciera ANTES del bucle:
      // acusaba «la ingesta volvió a imprimir y evaporar» sobre una capacidad
      // que acababa de mejorar. Un criterio que nombra un identificador
      // castiga el refactor que lo cumple mejor — la lección de la casa que
      // la cabecera de este archivo abre, cobrada otra vez.
      if (!/conCorridaRegistrada\(|registrarCorridaIngesta\(ctx/.test(cli)) {
        return falla('la ingesta volvió a imprimir y evaporar: nadie registra la corrida');
      }
      if ((cli.match(/registrarEventoEnSegundoPlano\(ctx/g) ?? []).length < 3) {
        return falla('los eventos del agente (sospecha/nudge/failover) perdieron cableado en el CLI');
      }
      return /this\.onNudge\?\.\(\)/.test(codigoDe('src/ai/grounding.ts'))
        ? ok('duración en los dos runners y el ledger, corridas de ingesta con consumo, y los tres eventos cableados')
        : falla('el guard de grounding dejó de avisar el nudge: el contador quedaría siempre en cero');
    },
  },

  {
    paquete: 'E5.1',
    id: 'single-auto-approval-authorizer',
    enunciado: 'Un solo autorizador: la vía de política lleva tope obligatorio y su «no casó» tiene nombre',
    mutantes: [
      {
        archivo: 'src/ai/ingest-service.ts',
        de: 'opts.deps?.autoApproveByPolicy ?? autoApproveDraftByPolicy',
        a: 'opts.deps!.autoApproveByPolicy',
        porque: 'el seam de pruebas se vuelve el camino de producción: el default al autorizador real desaparece',
      },
    ],
    evaluar: () => {
      // A3: había DOS autorizadores — matchApprovalPolicy con toda la
      // jurisprudencia (tope del operador vía Math.min, revocación,
      // last_used_at) y un gemelo huérfano que la ingesta no usaba. La
      // ingesta migró a la vía única: cuando una compuerta DISCRECIONAL no
      // basta, autoApproveDraftByPolicy tiene su oportunidad; las de
      // INTEGRIDAD retornan antes y jamás llegan ahí.
      const ing = codigoDe('src/ai/ingest-service.ts');
      // Forma de LLAMADA con el default (la lección de la firma-como-
      // callsite): el seam de pruebas debe caer al autorizador real, no a
      // un stub que aprobaría sin jurisprudencia.
      if (!/opts\.deps\?\.autoApproveByPolicy \?\? autoApproveDraftByPolicy/.test(ing)) {
        return falla('la ingesta dejó de caer al autorizador real: el seam de pruebas se volvió el camino de producción');
      }
      if (!/configuredMaxAmount: floorMaxAutoAmount\(thresholds\.maxAmount\)/.test(ing)) {
        return falla('la vía de política perdió el tope obligatorio del operador: una política podría autorizar por encima');
      }
      if (!/if \(veredicto\.integridad\)/.test(ing)) {
        return falla('la integridad dejó de retornar antes de la política: sospecha, multi-draft, moneda o cuadre se volverían negociables');
      }
      if (!/instanceof NoMatchingApprovalPolicyError/.test(ing)) {
        return falla('el «no casó» perdió el nombre: no se distinguiría de «casó y falló al aplicarse»');
      }
      // El huérfano pagó: la ingesta IMPORTA el autorizador del servicio de
      // borradores (si este import muere, E0.2 debe recongelar el símbolo).
      if (!/import\s*\{[^}]*\bautoApproveDraftByPolicy\b[^}]*\}\s*from '\.\/draft-service\.js'/.test(ing)) {
        return falla('la ingesta ya no importa autoApproveDraftByPolicy: volvería a haber dos autorizadores o ninguno');
      }
      return /code = 'NO_MATCHING_APPROVAL_POLICY'/.test(codigoDe('src/ai/draft-service.ts'))
        ? ok('vía única con tope floor-clampeado, integridad no negociable y NoMatchingApprovalPolicyError con código')
        : falla('el error de política sin casar perdió su código: los llamadores volverían a comparar strings');
    },
  },
  {
    paquete: 'E5.1',
    id: 'budget-enforced-at-session-chokepoint',
    enunciado: 'El presupuesto corta donde nacen las sesiones, y desatendido el tope es tope',
    mutantes: [
      {
        archivo: 'src/ai/budget.ts',
        de: "opts.unattended ? 'block' : 'warn'",
        a: "'warn'",
        porque: 'la ruta desatendida pierde su default block: «solo avisa» significa que no hay tope',
      },
    ],
    evaluar: () => {
      // A3 (spec E5.1-e): presupuesto opt-in por archivo de config, pero con
      // un default que distingue rutas: con humano enfrente, warn; en ruta
      // DESATENDIDA (grounding apagado = nadie mira), block — «solo avisa»
      // significa que no hay tope. Y el corte vive en el ÚNICO sitio donde
      // nacen las sesiones, no repartido por los llamadores.
      if (!existe('src/ai/budget.ts')) return falla('budget.ts no existe: el gasto del agente no tiene tope posible');
      const b = codigoDe('src/ai/budget.ts');
      if (!/opts\.unattended \? 'block' : 'warn'/.test(b)) {
        return falla('la ruta desatendida perdió su default block: un agente sin humano enfrente correría sin tope real');
      }
      if (!/code = 'AI_BUDGET_EXCEEDED'/.test(b)) {
        return falla('BudgetExceededError perdió su código: los llamadores no distinguirían tope de cualquier otro error');
      }
      // Declarado Y usado en la comparación (conteo, no presencia): mutar el
      // umbral del aviso dejando la constante viva pasa un chequeo laxo.
      if ((b.match(/BUDGET_WARN_RATIO/g) ?? []).length < 2) {
        return falla('el aviso del 80% dejó de compararse: el usuario se enteraría del tope al chocar con él');
      }
      if (!/sin medición/.test(b)) {
        return falla('block dejó de ser cerrado ante una base que no responde: un tope que no puede medirse no debe fingir que midió');
      }
      const prov = codigoDe('src/ai/providers/index.ts');
      if (!/const unattended = opts\.grounding\?\.enabled === false/.test(prov)) {
        return falla('la señal de desatendido se desconectó del grounding: la ruta sin humano dejaría de reconocerse');
      }
      if (!/await assertWithinBudget\(ctx, opts\.cwd, \{ unattended \}\)/.test(prov)) {
        return falla('createLlmSession dejó de pasar por el presupuesto: el chokepoint tiene un desvío');
      }
      // El decorador muerde al ENTRAR a cada turno: un cruce a mitad de
      // sesión corta sin esperar a la siguiente sesión.
      if (!/guard\.check\(\);\s*return session\.runTurn\(/.test(prov)) {
        return falla('withBudgetGuard dejó de checar por turno: un cruce a mitad de sesión seguiría gastando');
      }
      return /return withBudgetGuard\(session, guard\)/.test(prov)
        ? ok('presupuesto opt-in con block por default en desatendido, cerrado sin medición, y el guard muerde cada turno en el chokepoint')
        : falla('la sesión sale sin decorar: el guard existiría sin morder');
    },
  },
  {
    paquete: 'E5.1',
    id: 'shadow-verdicts-gate-auto-post',
    enunciado: 'La sombra opina sin postear, y encender el auto-posteo exige su historial',
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: 'c.decididos < FLOOR_SOMBRA_VEREDICTOS ||',
        a: '',
        porque: 'el piso pierde la vara del volumen decidido: tres comparaciones, cada una con ancla propia',
      },
    ],
    evaluar: () => {
      // A4: autoPost 'shadow' corre TODAS las compuertas, registra el
      // veredicto y no postea nada. La concordancia cruza esos veredictos
      // contra decisiones HUMANAS (nunca contra el propio umbral ni contra
      // políticas), y resolvePolicy exige ese historial antes de aceptar
      // 'on': el encendido es una decisión con evidencia, no una casilla.
      const m = 'src/database/migrations/047_el_veredicto_de_la_sombra.sql';
      if (!existe(m)) return falla('la 047 desapareció: la sombra no tendría dónde opinar');
      const sql = crudoDe(m);
      if (!/CREATE TABLE ai_shadow_verdicts/.test(sql) || !/UNIQUE \(draft_id\)/.test(sql)) {
        return falla('ai_shadow_verdicts perdió la unicidad por borrador: una sombra que opina dos veces infla su propia concordancia');
      }
      const ing = codigoDe('src/ai/ingest-service.ts');
      if (!/const modoSombra = thresholds\.sombra === true && !thresholds\.autoPost/.test(ing)) {
        return falla("la sombra dejó de excluir autoPost encendido: 'shadow' sólo tiene sentido cuando nada postea");
      }
      // El MISMO evaluador para el modo real y la sombra: el veredicto
      // registrado sale de evaluarAutoPost, no de una copia que diverge.
      //
      // EL ANCLA CAMBIÓ EN A7, Y ES LA MITAD DE LA HISTORIA. Pedía
      // literalmente `wouldAutoPost: veredicto.procede`, y eso era exacto
      // mientras el modo encendido tuviera UNA sola vía. A3 le añadió la
      // segunda —la política otorgada, cuando una compuerta discrecional no
      // basta— y entonces la fidelidad exigía lo contrario de lo que el
      // criterio pedía: registrar sólo el umbral mide un clasificador MÁS
      // CONSERVADOR que el que se enciende. El piso por criterio (S2) cazó
      // este cambio en el mismo commit, que es exactamente para lo que se
      // construyó. Se sigue exigiendo que el veredicto salga del evaluador
      // compartido, ahora componiéndolo con la vía de política.
      if (!/const habriaPosteado = veredicto\.procede \|\| porPolitica !== null/.test(ing)) {
        return falla('la sombra dejó de componer su veredicto con el evaluador compartido y la vía de política: mediría un clasificador que no es el real');
      }
      const sv = codigoDe('src/ai/shadow-verdicts.ts');
      if (!/ON CONFLICT \(draft_id\) DO NOTHING/.test(sv)) {
        return falla('el registro del veredicto perdió su idempotencia: reintentos duplicarían opiniones');
      }
      // Conteos ×2 (numerador Y denominador excluyen máquina): mutar uno
      // dejando el otro pasa un chequeo de presencia — la lección de R1.
      const notasAuto = (sv.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefPol = (sv.match(/'policy:%'/g) ?? []).length;
      if (notasAuto < 2 || prefPol < 2) {
        return falla(
          `la concordancia volvería a contar decisiones de máquina (nota auto ×${notasAuto}, prefijo policy ×${prefPol}): el agente se calificaría a sí mismo`
        );
      }
      const ps = codigoDe('src/services/policy/policy-service.ts');
      if (!/key === 'ingest_auto_post' && value === 'on'/.test(ps)) {
        return falla("la compuerta de evidencia desapareció de resolvePolicy: 'on' volvería a ser una casilla sin historial");
      }
      // Las TRES varas del piso, cada una comparada de verdad.
      if (
        !/c\.dias_con_veredictos < FLOOR_SOMBRA_DIAS/.test(ps) ||
        !/c\.decididos < FLOOR_SOMBRA_VEREDICTOS/.test(ps) ||
        !/acuerdo < FLOOR_SOMBRA_ACUERDO/.test(ps)
      ) {
        return falla('el piso del encendido perdió una de sus tres varas (días, volumen decidido, acuerdo)');
      }
      if (!/polAuto\.defined && polAuto\.value === 'shadow'/.test(codigoDe('src/ai/ingest-thresholds.ts'))) {
        return falla('la sombra dejó de ser SOLO del panel: un literal suelto en el archivo de config no debe encenderla');
      }
      return /value: 'shadow'/.test(codigoDe('src/services/policy/pending-catalog.ts'))
        ? ok('sombra panel-only con veredicto único por borrador, concordancia sobre humanos y encendido con peaje de evidencia')
        : falla('el panel perdió la opción shadow: el camino al encendido quedaría sin puerta');
    },
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

  // ============================================================
  // LOS CRITERIOS QUE EJECUTAN (S4a)
  //
  // Van en E0.1 —«red de seguridad»— y no en el paquete del tema que juzgan, y
  // conviene decir por qué en las dos direcciones.
  //
  // A FAVOR: E0.1 es el paquete de la demostración, no el de los informes ni
  // el del cierre. Lo que estos tres criterios añaden no es una afirmación
  // nueva sobre el dinero —el cierre ya tiene sus pruebas de integración— sino
  // que el TABLERO deje de creerle al texto. Ése es el objeto de E0.1.
  //
  // EN CONTRA, y queda anotado: el sitio temático del criterio del saldo sería
  // E4.2 (informes) y el del barrido, E1.1. Los dos están ABIERTOS, y un
  // criterio verde en paquete abierto tiene que entrar en
  // docs/criterios-minimos.json en el mismo commit —el piso de S2— que este
  // tramo no puede escribir: los suelos son del orquestador. Si se prefiere el
  // sitio temático, mover cada criterio y añadir su renglón al piso es un
  // cambio de dos líneas; no se hizo aquí porque habría dejado la CI en rojo
  // desde un archivo que no me toca tocar.
  // ============================================================
  ...PRUEBAS_DE_CONDUCTA.map(criterioDeConducta),
  // ══════════════════════════════════════════════════════════
  // S-UX · lote 2. Seis criterios que nacen de una lección repetida:
  // el guardián se deriva del ÁRBOL, nunca de una lista paralela. Los
  // cinco entregables de este tramo pasaron por un adversario con el
  // encargo de tumbarlos, y los cinco tenían el mismo defecto de
  // familia — la prueba miraba un árbol de juguete, una sola fila, o
  // un suelo con holgura. Cada criterio de abajo cita el mutante que
  // SOBREVIVÍA antes de armarlo.
  // ══════════════════════════════════════════════════════════
  {
    paquete: 'E5.1',
    id: 'shell-completion-from-shipped-tree',
    enunciado:
      'El guion de completado se genera del árbol embarcado entero, y su cuerpo no le devuelve la lista al shell para que la expanda',
    mutantes: [
      {
        archivo: 'src/cli/completion-command.ts',
        de: '      visit(child, childPath);',
        a: '      if (childPath.length < 3) visit(child, childPath);',
        porque:
          'profundidad-truncada: un generador que se detiene un nivel antes pierde las 53 tablas de tercer nivel (el guion cae de 597 a 544 líneas) y una prueba sobre un árbol sintético de dos niveles no tiene tercer nivel que perder',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('src/cli/completion-command.ts');
      // El recorrido no se topa: un tope de profundidad es el modo de
      // fallo que deja `sat cred add --<TAB>` sin ofrecer --dry-run.
      if (/childPath\.length\s*<\s*\d/.test(gen)) {
        return falla('el generador de completado topó la profundidad del recorrido: las hojas de tercer nivel perderían su tabla de banderas');
      }
      // Escape con bandera GLOBAL. Sin /g sólo se escapa la primera
      // comilla, y un nombre con dos deja el resto del texto donde el
      // shell lo expande. Demostrado en bash 3.2: se ejecuta.
      if (!/\.replace\(\/'\/g,/.test(gen)) {
        return falla('shellQuote perdió la bandera global del escape: un nombre con dos comillas deja carga ejecutable en el guion');
      }
      // El cuerpo consumidor lee palabra a palabra. `compgen -W` EXPANDE
      // la lista, así que devuelve al shell justo lo que las tablas
      // habían entrecomillado bien. OJO al ancla: el módulo NOMBRA
      // «compgen -W» dentro del comentario BASH que lo prohíbe, y ese
      // comentario viaja en una cadena de TypeScript, así que
      // codigoDe() no lo quita. Buscar el nombre acusaría a la frase
      // que previene el defecto — el primer intento de este criterio
      // hizo justo eso. Se ancla en la CONDUCTA: ninguna línea que
      // abra `candidates=(` puede continuar con una expansión.
      if (/candidates=\(\s*\$\(/.test(gen)) {
        return falla('el consumidor del guion volvió a construir la lista con una expansión: un alias hostil ejecuta código al pulsar TAB');
      }
      if (!/while IFS= read -r word/.test(gen)) {
        return falla('el cuerpo del guion perdió el lector línea a línea: es la pieza que impide que el shell expanda lo que se le ofrece');
      }
      // Y el guardián mira el objeto que la pieza produce: el program
      // EMBARCADO, no un árbol inventado. Ésta es la lección entera.
      const spec = codigoDe('tests/cli/completion-command.spec.ts');
      return /from '\.\.\/\.\.\/src\/cli\/mnemosine\.js'/.test(spec)
        ? ok('el completado se genera del árbol embarcado, con escape global y sin reexpansión en el consumidor')
        : falla('la prueba del completado dejó de importar el program embarcado: volvería a certificar un árbol de juguete');
    },
  },
  {
    paquete: 'E5.1',
    id: 'cli-reference-mirrors-real-help',
    enunciado:
      'El documento que el agente lee como «el binario exacto» reproduce la ayuda real, con los ejemplos incluidos',
    mutantes: [
      {
        archivo: 'scripts/generate-cli-reference.ts',
        de: "  emitir(cmd, 'afterHelp', contexto);",
        a: '  // emitir(cmd, contexto);',
        porque:
          'ayuda-a-medias: helpInformation() no dispara afterHelp, así que las 244 invocaciones de ejemplo desaparecen del documento mientras el generador sigue prometiendo fidelidad byte a byte',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('scripts/generate-cli-reference.ts');
      if (!/emitir\(cmd, 'afterHelp', contexto\)/.test(gen)) {
        return falla('el generador volvió a la ayuda sin afterHelp: los ejemplos no llegarían al documento que el agente lee como el binario');
      }
      // Conteo sobre el ARTEFACTO, no sobre el generador: un generador
      // correcto con un documento sin regenerar es el mismo hueco.
      const doc = crudoDe('src/ai/docs/cli-reference.md');
      const ejemplos = (doc.match(/Examples:/g) ?? []).length;
      if (ejemplos < 100) {
        return falla(
          `cli-reference.md sólo trae ${ejemplos} bloques de ejemplos: el documento está sin regenerar y el agente no ve la mitad visible de la ayuda`
        );
      }
      return ok(`el documento del agente reproduce la ayuda real: ${ejemplos} bloques de ejemplos`);
    },
  },
  {
    paquete: 'E5.1',
    id: 'every-help-example-parses',
    enunciado:
      'Todo ejemplo de la ayuda lo acepta el Commander embarcado, en la hoja en cuya ayuda vive, y ninguno enseña la clave legada tax=',
    mutantes: [
      {
        archivo: 'src/cli/bill-command.ts',
        de: 'tax-amount=2000.00',
        a: 'tax=16',
        porque:
          'ejemplo-que-miente: tax= es TASA en invoice y MONTO en bill, así que el ejemplo copiable registraría 16 pesos de IVA donde van 2 000 — la confusión H3 que este tramo existe para curar, en el propio texto que la cura',
      },
    ],
    evaluar: () => {
      const spec = codigoDe('tests/cli/ejemplos-de-ayuda.spec.ts');
      // La prueba PARSEA con el Commander real: comprobar que la bandera
      // existe deja pasar el ejemplo al que le falta el argumento
      // posicional, y ése muere en el parser del usuario, no en CI.
      if (!/\.parse\(argv, \{ from: 'user' \}\)/.test(spec)) {
        return falla('el guardián de ejemplos dejó de pasar las invocaciones por el Commander real: un ejemplo sin su argumento posicional volvería a pasar en verde');
      }
      // Los suelos van en el valor MEDIDO. Un suelo con holgura no es un
      // trinquete: es un permiso — con 97 sobre 115 se podía borrar una
      // familia documentada entera sin un solo rojo.
      const suelos = spec.match(/(?:SUELO|MINIMO)_[A-Z_]+\s*=\s*(\d+)/g) ?? [];
      if (suelos.length < 2) {
        return falla('el guardián de ejemplos perdió sus suelos medidos: sin ellos un revert parcial pasa en verde');
      }
      const bill = codigoDe('src/cli/bill-command.ts');
      const ejemplosDeBill = bill.slice(bill.indexOf('EJEMPLOS'));
      return /tax-amount=/.test(ejemplosDeBill) && !/--line "[^"]*[,"]tax=/.test(ejemplosDeBill)
        ? ok('los ejemplos parsean contra el Commander embarcado y bill enseña tax-amount, no la clave legada')
        : falla('un ejemplo de bill volvió a la clave legada tax=: registraría el IVA con un factor de diez');
    },
  },
  {
    paquete: 'E5.1',
    id: 'contract-exit-codes-have-producers',
    enunciado:
      'El 8 y el 9 del contrato tienen productor de verdad: un fallo externo transitorio y un rechazo definitivo mueren con enteros distintos',
    mutantes: [
      {
        archivo: 'src/services/integrations/accounting/contalink-adapter.ts',
        de: '      throw new ExternalRejectedError(this.name, `HTTP ${response.status} at ${path}`, detalle);',
        a: '      throw new ExternalServiceError(this.name, `HTTP ${response.status} at ${path}`, detalle);',
        porque:
          'rechazo-disfrazado-de-fallo: un 401 (credencial muerta) o un 422 (payload que jamás aceptará) saldrían por el 8, y el contrato dice de ese 8 «Retryable» — el cron reintentaría para siempre una petición que nunca puede salir bien',
      },
      {
        archivo: 'src/services/integrations/accounting/contalink-adapter.ts',
        // El espejo anterior aquí era un NO-OP MEDIDO: reescribía el `json()`
        // como `Promise.resolve(response).then(...)`, que hace exactamente lo
        // mismo dentro del mismo try. Mataba al criterio por su expresión
        // regular, no por la conducta — que es el fallo que este proyecto
        // persigue, cometido por el espejo que lo vigila. Éste SÍ neutraliza:
        // saca la decodificación FUERA del try, que es el defecto literal.
        de: '    let data: T;\n    try {\n      data = (await response.json()) as T;',
        a: '    const data = (await response.json()) as T;\n    try {',
        porque:
          'el-cuarto-desenlace: el `json()` vuelve a quedar FUERA del guarda, así que un proxy o un portal cautivo que conteste 200 con HTML da un SyntaxError pelado que sale por el 1 genérico y ni siquiera nombra al proveedor',
      },
      {
        archivo: 'src/cli/kernel/index.ts',
        de: '  424: ExitCode.EXTERNAL_REJECTED,',
        a: '  424: ExitCode.FAILURE,',
        porque:
          'la-puerta-tapiada: la única fila del mapa que produce el 9. Borrada, la clase ExternalRejectedError sigue existiendo intacta y el árbol compila — pero todo rechazo definitivo vuelve al 1 genérico y el 9 vuelve a ser papel',
      },
      {
        archivo: 'src/ai/external-service.ts',
        de: '    if (err instanceof ExternalRejectedError || err instanceof ExternalServiceError) {',
        a: '    if (false) {',
        porque:
          'el-veredicto-aplastado-al-final: el adaptador clasifica y executeExternalOp vuelve a envolverlo en un Error pelado, así que `outbox run` —la hoja que llama un cron— pierde la distinción en el último paso pese a que todo lo anterior la calculó bien',
      },
      {
        archivo: 'src/cli/kernel/exit.ts',
        de: '  if (codes.includes(ExitCode.EXTERNAL_FAILED)) return ExitCode.EXTERNAL_FAILED;',
        a: '  if (codes.includes(ExitCode.EXTERNAL_REJECTED)) return ExitCode.EXTERNAL_REJECTED;',
        porque:
          'el-lote-condenado: invierte quién domina en un lote mixto, así que un lote con UNA operación viva y una rechazada sale 9 («no reintentes nunca») y la que sí podía salir bien no se reintenta jamás',
      },
    ],
    evaluar: async () => {
      // SE MIDE **Y** SE LEE EL FUENTE, y hacen falta las dos.
      //
      // El arnés de mutación gobierna la LECTURA DE TEXTO, así que un criterio
      // que sólo hiciera `await import()` sería inmune a sus propios espejos.
      // Pero uno que sólo lea texto sobrevive a una conducta rota: éste lo
      // hacía —seguía verde con el reparto que convierte un rechazo definitivo
      // en «reintentable», que es LITERALMENTE el daño que describe su primer
      // espejo—. Así que primero se ejecuta el reparto de verdad.
      const { ExitCode, batchExitCode } = await import('../cli/kernel/exit.js');
      const { exitCodeFor } = await import('../cli/kernel/index.js');
      const { ExternalRejectedError, ExternalServiceError } = await import('../utils/errors.js');
      const transitorio = exitCodeFor(new ExternalServiceError('contalink', 'unreachable'));
      const definitivo = exitCodeFor(new ExternalRejectedError('contalink', 'HTTP 401'));
      if (transitorio !== ExitCode.EXTERNAL_FAILED || definitivo !== ExitCode.EXTERNAL_REJECTED) {
        return falla(
          `un fallo transitorio muere con ${transitorio} y un rechazo definitivo con ${definitivo}: ` +
            'el contrato publica 8=reintenta y 9=no reintentes nunca, y un cron no puede actuar sobre ' +
            'una distinción que el binario no expresa'
        );
      }
      // Y el veredicto del LOTE: uno solo que pueda reintentarse manda sobre
      // los rechazos, porque condenar el lote entero deja sin reintento a la
      // operación que sí podía salir bien.
      if (
        batchExitCode([ExitCode.EXTERNAL_REJECTED, ExitCode.EXTERNAL_FAILED]) !== ExitCode.EXTERNAL_FAILED ||
        batchExitCode([ExitCode.EXTERNAL_REJECTED]) !== ExitCode.EXTERNAL_REJECTED
      ) {
        return falla('el veredicto del lote dejó de distinguir «alguna se puede reintentar» de «todas fueron rechazadas»');
      }

      // AHORA EL TEXTO, que es lo que el arnés puede mutar.
      const ad = codigoDe('src/services/integrations/accounting/contalink-adapter.ts');

      // 1. Los CUATRO desenlaces del adaptador están clasificados. Antes
      //    los cuatro eran `new Error(...)` y salían por el 1 genérico.
      if (/throw new Error\(/.test(ad)) {
        return falla(
          'el adaptador de Contalink volvió a tirar un Error pelado: ese desenlace sale por el 1 genérico y un cron no puede distinguir «reintenta» de «no reintentes nunca»'
        );
      }
      if (!/catch[\s\S]{0,400}ExternalServiceError\(this\.name, `unreachable at/.test(ad)) {
        return falla('la llamada de red quedó fuera de su guarda: un DNS caído o una conexión rechazada saldría por el 1, sin nombrar al proveedor');
      }
      // El cuarto desenlace, el que no estaba en el issue: response.json()
      // vivía FUERA de todo try.
      if (!/try \{\s*\n\s*data = \(await response\.json\(\)\) as T;/.test(ad)) {
        return falla('response.json() volvió a quedar fuera del try: un 200 con HTML de un proxy da un SyntaxError pelado que ni siquiera nombra al proveedor');
      }
      if (!/esTransitorio\(response\.status\)/.test(ad) || !/ExternalRejectedError\(this\.name, `HTTP/.test(ad)) {
        return falla('el adaptador dejó de separar el 5xx/408/429 del 4xx: un rechazo definitivo volvería a leerse como reintentable');
      }

      // 2. Las DOS puertas del mapa. La de 502 existía desde el principio y
      //    nunca se activó por falta de productor; la de 424 es la única
      //    que produce el 9.
      const mapa = codigoDe('src/cli/kernel/index.ts');
      if (!/502: ExitCode\.EXTERNAL_FAILED/.test(mapa) || !/424: ExitCode\.EXTERNAL_REJECTED/.test(mapa)) {
        return falla('el mapa de estados perdió una de las dos puertas externas: el código publicado que la cruzaba vuelve a ser inalcanzable');
      }
      const errores = codigoDe('src/utils/errors.ts');
      if (!/class ExternalServiceError extends AppError/.test(errores) ||
          !/class ExternalRejectedError extends AppError/.test(errores)) {
        return falla('desaparecieron las clases que llevan los estados 502/424: sin productor, las dos filas del mapa vuelven a ser decorado');
      }

      // 3. El veredicto SOBREVIVE al re-envoltorio del outbox.
      const svc = codigoDe('src/ai/external-service.ts');
      if (!/instanceof ExternalRejectedError \|\| err instanceof ExternalServiceError/.test(svc)) {
        return falla('executeExternalOp volvió a aplastar el veredicto del adaptador en un Error pelado: `outbox run` pierde la distinción en el último paso');
      }

      // 4. Y la hoja que llama un cron COMPONE su código en vez de fijarlo.
      //    `failed > 0 ? 1 : 0` no lo veía ningún censo de `shutdown(1)`.
      const raiz = codigoDe('src/cli/mnemosine.ts');
      if (/shutdown\(failed > 0 \? 1 : 0\)/.test(raiz)) {
        return falla('`outbox run` volvió a fijar su código a 1: el lote entero informa lo mismo tras un corte de red que tras una credencial revocada');
      }
      if (!/shutdown\(batchExitCode\(veredictos\)\)/.test(raiz)) {
        return falla('`outbox run` dejó de componer su código con batchExitCode: un lote que siguió adelante no puede lanzar, así que si no compone, miente');
      }
      const ex = codigoDe('src/cli/kernel/exit.ts');
      if (!/export function batchExitCode/.test(ex) ||
          !/if \(codes\.includes\(ExitCode\.EXTERNAL_FAILED\)\) return ExitCode\.EXTERNAL_FAILED;/.test(ex)) {
        return falla('batchExitCode perdió la regla de que lo reintentable domina: un lote mixto saldría 9 y la operación que aún podía salir bien no se reintentaría nunca');
      }

      // 5. Y el contrato publicado dice quién los produce, en su idioma.
      const doc = crudoDe('docs/cli-command-registry.md');
      if (!/ExternalServiceError/.test(doc) || !/ExternalRejectedError/.test(doc)) {
        return falla('la tabla publicada volvió a prometer el 8 y el 9 sin nombrar quién los produce: «se documenta y no ocurre» es el defecto');
      }

      return ok('el 8 y el 9 nacen en el adaptador, sobreviven al outbox y llegan distintos al process.exit; los cuatro desenlaces externos están clasificados');
    },
  },
  {
    paquete: 'E5.1',
    id: 'cli-leaf-preserves-exit-code',
    enunciado:
      'Ninguna hoja del CLI aplasta su código de salida: el catch devuelve el código del contrato, y el error de uso de Commander pasa por la puerta que cierra el pool',
    mutantes: [
      {
        archivo: 'src/cli/memory-command.ts',
        de: '        await deps.shutdown(exitCodeFor(err));',
        a: '        await deps.shutdown(1);',
        porque:
          'código-aplastado: una hoja que ninguna fila conductual visita, con un texto que ningún grep de «shutdown(1)» esperaba encontrar de vuelta — 39 de 179 hojas vivían así y el contrato de trece códigos era papel',
      },
    ],
    evaluar: () => {
      // Barrido de la clase entera, no de la instancia: el defecto que
      // este criterio vigila vivía en 14 archivos a la vez.
      const archivos = fs
        .readdirSync(rutaDe('src/cli'))
        .filter((n) => n.endsWith('.ts'))
        .sort();
      const aplastan: string[] = [];
      for (const nombre of archivos) {
        if (/shutdown\(1\)/.test(codigoDe('src/cli', nombre))) aplastan.push(nombre);
      }
      if (aplastan.length > 0) {
        return falla(
          `${aplastan.length} archivo(s) del CLI vuelven a aplastar el código de salida a 1: ${aplastan.slice(0, 4).join(', ')} — el contrato de trece códigos vuelve a ser papel`
        );
      }
      // Y la capa de Commander: sin exitOverride, un error de uso sale
      // por el process.exit() propio de Commander, con código 1 y sin
      // drenar las atestaciones ni cerrar el pool.
      const raiz = codigoDe('src/cli/mnemosine.ts');
      return /exitOverride/.test(raiz)
        ? ok(`ninguna hoja aplasta su código de salida (${archivos.length} archivos barridos) y Commander pasa por la puerta del kernel`)
        : falla('el program perdió exitOverride: los errores de uso saldrían con 1 y sin cerrar el pool');
    },
  },
  {
    paquete: 'E4.2',
    id: 'report-sections-are-identified-by-key',
    // I11 · issue #153, primer commit. Los rótulos de las secciones del balance
    // y del estado de resultados se van a traducir, y tres superficies los leían
    // como identidad: la herramienta del agente derivaba `category` del rótulo
    // («Current Assets» → `current_assets`) y buscaba el resultado del ejercicio
    // por su nombre inglés; la API y `report … --json` los publican. Traducir
    // sin esto le habría cambiado al agente `current_assets` por
    // `activo_circulante` y le habría quitado `equity.result_of_the_period` en
    // silencio, que es lo que `src/ai/docs/reports.md` le promete.
    //
    // Este criterio NO exige todavía que los rótulos salgan del catálogo: eso es
    // el commit siguiente, y su criterio tendrá que mirar los SEIS literales.
    // Lo que fija es la identidad: existe una clave y los consumidores la usan.
    enunciado:
      'Las secciones de los informes tienen clave estable, y el agente agrupa por ella y no por el rótulo inglés',
    mutantes: [
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: '            category: sub.key,',
        a: "            category: sub.name.toLowerCase().replace(/ /g, '_'),",
        porque:
          'categoria-derivada-del-rotulo: el agente volvería a agrupar por el nombre, así que el día que se traduzca recibiría `activo_circulante` donde su manual le promete `current_assets`',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: "        (x: Seccion['subsections'][number]) => x.key === 'result_of_the_period'",
        a: "        (x: Seccion['subsections'][number]) => x.name === 'Result Of The Period'",
        porque:
          'resultado-buscado-por-nombre: traducido el rótulo, la búsqueda no encuentra nada y `equity.result_of_the_period` desaparece del JSON sin que nada lo acuse',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "      key: 'result_of_the_period',\n",
        a: '',
        porque:
          'subseccion-sin-clave: la única subsección que no viene de `fs_category` se quedaría sin identidad, y quien la busque tendría que volver al rótulo',
      },
    ],
    evaluar: () => {
      const codeLines = (rel: string): string[] =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

      const types = codeLines('src/types/index.ts').join('\n');
      if (!/export interface BalanceSheetSection \{\s*key: string;/.test(types)) {
        return falla('BalanceSheetSection perdió su clave: la identidad de una sección volvería a ser su rótulo, que se traduce');
      }
      if (!/export interface IncomeStatementSection \{\s*key: string;/.test(types)) {
        return falla('IncomeStatementSection perdió su clave: revenue y expenses volverían a identificarse por su rótulo');
      }

      const service = codeLines('src/services/reporting/report-service.ts').join('\n');
      const missing = ["key: 'assets'", "key: 'liabilities'", "key: 'equity'", "key: 'result_of_the_period'"]
        .filter((k) => !service.includes(k));
      if (missing.length > 0) {
        return falla(`report-service no rellena ${missing.length} clave(s) de sección (${missing.join(', ')}): la traducción del rótulo se llevaría por delante la identidad`);
      }
      if (!/key: type === 'revenue' \? 'revenue' : 'expenses'/.test(service)) {
        return falla('las secciones del estado de resultados dejaron de llevar clave');
      }

      const tools = codeLines('src/ai/tools/report-tools.ts').join('\n');
      if (!/category: sub\.key,/.test(tools)) {
        return falla('la herramienta del agente volvió a derivar `category` del rótulo: agruparía distinto en cuanto el rótulo se traduzca');
      }
      if (!/x\.key === 'result_of_the_period'/.test(tools)) {
        return falla('la herramienta del agente busca el resultado del ejercicio por su rótulo: traducido, lo perdería en silencio');
      }
      if (/sub\.name\.toLowerCase\(\)/.test(tools) || /=== 'Result Of The Period'/.test(tools)) {
        return falla('queda una lectura del rótulo inglés en la herramienta del agente');
      }
      return ok('las secciones llevan clave estable y el agente agrupa y busca por ella, no por el rótulo');
    },
  },
  {
    paquete: 'E4.2',
    id: 'report-labels-come-from-the-catalog',
    // I11 · issue #153, SECOND commit — the one the criterion above announces in
    // writing. That one pinned the IDENTITY (a key exists and the agent groups by
    // it); this one watches the LABEL: that the prose a person reads comes out of
    // the catalog, and that it comes out AT THE EDGE.
    //
    // WHY AT THE EDGE, which is the most valuable thing there is to watch here.
    // No file under `src/services/` imports `src/i18n/`, and that is no accident:
    // the two surfaces that read the language resolve it in incompatible ways.
    // The CLI pins it in a module global at start-up; the API only has it in
    // `res.locals`, because it negotiates it per request. A service that asked
    // `getLanguage()` would make EVERY HTTP response come out in the language of
    // the process and ignore `Accept-Language` — the exact defect I9 has just
    // closed in the errors, and which would come back through the door next to it.
    // That is why the service goes on minting its English `name`, the key is the
    // identity, and each human surface paints the label with the language it
    // actually has.
    //
    // WHAT A NAIVE CRITERION LETS THROUGH. The issue proposed scanning
    // `report-service.ts` and nothing else. With that, `report-command.ts` could
    // go on printing 'Total Liabilities and Equity', 'Net income' and
    // `Total ${sub.name}` underneath a table in Spanish, and the criterion stayed
    // green: the three shadow copies lived there and had NO test at all —the 1 928
    // in tests/cli, tests/i18n and tests/services/reporting passed without touching
    // them—. So what is looked at here is BOTH files, the row that travels with the
    // key, the hooks of BOTH human branches, the tree walk that defends the
    // invariant, and the catalog measured against the domain the migration declares.
    //
    // WHAT MEASURING IT WITH THE SEAM FOUND (two attackers, six escapes). A
    // criterion is worth exactly the mutants that have been run against it, and
    // six survived this one. Markdown was not watched at all, while `--format md
    // -o` is the deliverable the wiki teaches. `'Net Income'` walked past a guard
    // whose three neighbours all carried `i`. `'Total ' +` walked past a guard
    // that only knew `${}`. Three of the five catalog keys the command needs were
    // not required at all. The catalogs were read RAW, so commenting a key out
    // retired it from the program and not from the guard — and a key that lived
    // only inside a comment satisfied the guard that every `t('report.*')`
    // resolves, while `t()` throws. And the invariant matched a STRING instead of
    // asking the graph, so a barrel re-export, a `require()` and a computed
    // specifier all went under it. Every one of those is a mutant below.
    enunciado:
      'Los rótulos de los informes salen del catálogo en el borde, y ningún servicio importa el idioma',
    mutantes: [
      {
        archivo: 'src/cli/report-command.ts',
        de: "      rows.push({ section: '', code: '', name: '', amount: is.net_income, line: 'total' });",
        a: "      rows.push({ section: '', code: '', name: 'Net Income', amount: is.net_income, line: 'total' });",
        porque:
          'rotulo-ingles-con-otra-caja: la prosa vuelve a la FILA, y en mayúscula. El guardia de este rótulo era el único de los cuatro sin la bandera `i`, así que «Net Income» pasaba por delante de él mientras «Net income» moría — un rótulo se escapa cambiando una letra de caja',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_of', { name: reportCategoryLabel(keyOf(row.category)) })",
        a: "`Total ${reportCategoryLabel(keyOf(row.category))}`",
        porque:
          'concatenacion-que-fija-el-orden: la palabra «Total» vuelve al código con el orden inglés cosido, de modo que ninguna traducción puede moverla de sitio aunque el rótulo que la acompaña sí se traduzca',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_of', { name: reportCategoryLabel(keyOf(row.category)) })",
        a: "'Total ' + reportCategoryLabel(keyOf(row.category))",
        porque:
          'el-pegado-que-no-es-plantilla: el mismo defecto escrito con `+` en vez de con `${}`. El guardia miraba sólo la plantilla, así que la forma más natural de recaer —concatenar— salía verde con «Total» cosido delante igual que antes',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_liabilities_and_equity')",
        a: "reportSectionLabel('total_liabilities_and_equity')",
        porque:
          'clave-obligatoria-que-nadie-exigia: el renglón de la suma deja de pedirle su prosa al catálogo y se la pide al rotulador de secciones, que no tiene esa clave y cae al identificador crudo. La lista de claves obligatorias sólo nombraba las dos notas al pie, así que los tres rótulos compuestos podían irse sin que nada se pusiera rojo',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: '              section: section.key,\n              category: sub.key,',
        a: '              section: section.name,\n              category: sub.name,',
        porque:
          'la-fila-lleva-el-rotulo: csv y json volverían a cambiar con el idioma de quien lee, así que dos corridas de la misma orden darían dos documentos distintos y ningún consumidor de máquina podría agrupar por sección',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: "return { data: toTable(rows, cols, numeric, p, opts.jurisdiction, opts.labelled) + '\\n', notes: aviso };",
        a: "return { data: toTable(rows, cols, numeric, p, opts.jurisdiction) + '\\n', notes: aviso };",
        porque:
          'tabla-sin-rotulador: la rama para humanos dejaría de recibir el gancho y el balance imprimiría `non_current_assets` a una persona, con las cifras correctas al lado para que nadie sospeche',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: "return { data: toMarkdown(rows, cols, opts.labelled) + '\\n', notes: aviso };",
        a: "return { data: toMarkdown(rows, cols) + '\\n', notes: aviso };",
        porque:
          'markdown-sin-rotulador: la SEGUNDA rama humana deja de recibir el gancho. `--format md -o` es lo que la wiki enseña como el entregable del mes, así que el informe que se entrega imprimiría `assets` donde la tabla pone «Assets» — y el guardia de las ramas de máquina no nombraba toMarkdown, de modo que esto salía verde',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '            return esc(label !== undefined ? label(cell(r[c]), r) : cell(r[c]));',
        a: '            return esc(cell(r[c]));',
        porque:
          'gancho-recibido-y-no-aplicado: toMarkdown sigue declarando el parámetro y no lo usa, que es la forma de fallo que una comprobación de FIRMA no ve. El markdown saldría sin rótulos con la firma intacta',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '  const format = resolveFormat(opts);',
        a:
          '  const format = resolveFormat(opts);\n' +
          '  rows = rows.map((r) => ({ ...r, ...Object.fromEntries(Object.entries(opts.labelled ?? {}).map(([c, f]) => [c, f(cell(r[c]), r)])) }));',
        porque:
          'rotular-una-vez-y-arriba: el atajo natural —rotular antes del switch de formato— haría que csv, json y ndjson contestaran en el idioma del lector, que es dejar de ser formatos de máquina; el dinero ya tiene escrito ahí por qué esa rama es sólo para humanos',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nimport { t } from '../../i18n/index.js';",
        porque:
          'idioma-dentro-del-servicio: el servicio pasa a resolver el idioma por su cuenta y sólo puede resolver el del PROCESO, así que la API contestaría en español a quien pide inglés e ignoraría Accept-Language — el defecto que I9 acaba de cerrar en los errores',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nconst { t } = require('../../i18n/index.js');",
        porque:
          'el-mismo-import-por-la-puerta-de-atras: `require()` carga exactamente lo mismo y la invariante casaba `from` o `import(`, así que la forma CommonJS del defecto entraba entera sin tocar ninguna puerta',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nconst catalog = await import(LANGUAGE_MODULE);",
        porque:
          'especificador-que-no-se-puede-leer: con la ruta en una variable no hay cadena que casar, así que cualquier invariante escrita como búsqueda de texto queda ciega por construcción; un servicio no tiene ninguna razón para cargar un módulo computado',
      },
      {
        archivo: 'src/types/index.ts',
        de: 'export enum AccountType {',
        a: "export { t } from '../i18n/index.js';\n\nexport enum AccountType {",
        porque:
          'el-barril-que-esquiva-la-invariante: ningún archivo de src/services nombra i18n y aun así todos pueden leer el idioma, porque veinte de ellos importan este barril por su valor. La invariante casaba una CADENA y el grafo pasaba por debajo',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.category.ori': 'Other comprehensive income',\n",
        a: '',
        porque:
          'categoria-sin-rotulo: `ori` es la categoría que la 078 añadió al CHECK y que el enum no tenía; sin su entrada el balance imprime la clave cruda «ori» donde debería decir el renglón de la NIF B-3, y el rotulador cae a la clave en vez de lanzar, así que nada lo acusa',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.category.ori': 'Other comprehensive income',",
        a: "  // 'report.category.ori': 'Other comprehensive income',",
        porque:
          'comentar-en-vez-de-borrar: la entrada sigue en el archivo y ya no existe para el programa. El catálogo se leía CRUDO, así que la forma más común de retirar una línea —comentarla— dejaba el criterio verde con el balance imprimiendo «ori»',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.net_income': 'Net income',",
        a: "  // 'report.net_income': 'Net income',",
        porque:
          'clave-que-vive-solo-en-un-comentario: peor que el anterior, porque el guardia que comprueba que toda `t(\'report.*\')` existe la DABA POR BUENA leyendo el archivo crudo. `t()` no cae a otro idioma: lanza, y el informe no llega a imprimirse',
      },
      {
        archivo: 'src/i18n/report-labels.ts',
        de: '  return isKnown(key) ? t(key, {}, language) : fallback;',
        a: "  return isKnown(key) ? t(key, {}, 'en') : fallback;",
        porque:
          'rotulador-que-clava-el-idioma: las dos funciones siguen exportadas, el catálogo sigue completo y la tabla sigue rotulando — en inglés, siempre. Un criterio que sólo mira quién llama a quién no distingue esto de lo correcto',
      },
    ],
    evaluar: () => {
      // Read through the seam, and filter the comment lines BY HAND: `sinComentarios`
      // goes blind on big files full of backticks, and here nearly everything that is
      // FORBIDDEN is quoted in the prose that explains why it is forbidden. A criterion
      // that accuses itself does not measure.
      //
      // THE CATALOGS ARE READ THE SAME WAY, and that is not tidiness. Commenting
      // `'report.category.ori'` out instead of deleting it used to leave this green —
      // the most common way anybody retires a line — and worse: a key that exists ONLY
      // inside a comment used to satisfy the guard that every `t('report.*')` resolves.
      // `t()` does not fall back to another language, it throws.
      const codeOf = (rel: string): string =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');

      /** One top-level declaration, from its keyword to the next one. */
      const declarationIn = (source: string, name: string): string => {
        const start = Math.max(source.indexOf(`function ${name}(`), source.indexOf(`const ${name} =`));
        if (start === -1) return '';
        const rest = source.slice(start);
        const end = rest.slice(1).search(/\n(?:export )?(?:function|const|interface|type|import|class|enum) /);
        return end === -1 ? rest : rest.slice(0, end + 1);
      };

      // ── The edge labeller exists, exports both functions, and pins no language ──
      const edge = 'src/i18n/report-labels.ts';
      if (!existe(edge)) {
        return falla(
          `${edge} no existe: no hay rotulador en el borde, así que el rótulo volvería al literal inglés del comando o —peor— al servicio`
        );
      }
      const labeller = codeOf(edge);
      for (const fn of ['reportSectionLabel', 'reportCategoryLabel']) {
        if (!new RegExp(`export function ${fn}\\(`).test(labeller)) {
          return falla(`${edge} dejó de exportar ${fn}: la superficie humana no tendría de dónde sacar el rótulo`);
        }
      }
      // BEHAVIOUR belongs to the tests; what a criterion can hold is the shape that
      // makes the behaviour possible. `isKnown` probes the catalog in a fixed language
      // on purpose —it asks whether the key EXISTS, not what it says— and it is the
      // only place allowed to name one. Anywhere else, a literal language is a
      // labeller that answers in it forever while every call site still looks right.
      const outsideGuard = labeller.replace(/function isKnown\([\s\S]*?\n\}/, '');
      if (/\bt\(\s*[^)]*['"](?:en|es)['"]/.test(outsideGuard)) {
        return falla(
          'report-labels.ts clava un idioma en una llamada a t() fuera de su guardia `isKnown`: ' +
            'el informe saldría siempre en ese idioma con toda la cadena de llamadas intacta'
        );
      }

      // ── 1. The three shadow copies, which had no test ──
      const cli = codeOf('src/cli/report-command.ts');
      // Every one of these carries `i`. The `Net income` guard was the one that did
      // not, and a label escapes by changing the case of a single letter.
      const forbidden: [RegExp, string][] = [
        [/Total Liabilities and Equity/i, "el rótulo fijo 'Total Liabilities and Equity'"],
        [/['"`]Net income['"`]/i, "el rótulo fijo 'Net income'"],
        [/= Liabilities \+ Equity/i, 'la comprobación del balance redactada en inglés'],
        [/`[^`\n]*Total \$\{/i, 'la concatenación `Total ${…}`, que cose el orden de las palabras'],
        // The same defect written with `+`. A guard that only knew the template form
        // blessed the most natural way to relapse.
        [
          /['"]\s*Total\s*['"]\s*\+|\+\s*['"]\s*Total\s*['"]/i,
          'el pegado de «Total» con `+`, que cose el orden de las palabras igual que la plantilla',
        ],
      ];
      for (const [pattern, what] of forbidden) {
        if (pattern.test(cli)) {
          return falla(
            `report-command.ts volvió a llevar ${what}: la CLI imprimiría inglés debajo de una tabla en español, y ninguna prueba de las 1 928 lo acusa`
          );
        }
      }
      if (!/from '\.\.\/i18n\/report-labels\.js'/.test(cli)) {
        return falla('report-command.ts dejó de leer el rotulador del borde: los rótulos volverían a escribirse dentro del comando');
      }
      const used = [...new Set([...cli.matchAll(/t\('(report\.[a-z_.]+)'/g)].map((m) => m[1]))];
      const englishCatalog = codeOf('src/i18n/en.ts');
      const spanishCatalog = codeOf('src/i18n/es.ts');
      const unknownKeys = used.filter(
        (k) => !englishCatalog.includes(`'${k}':`) || !spanishCatalog.includes(`'${k}':`)
      );
      if (unknownKeys.length > 0) {
        return falla(
          `report-command.ts pide ${unknownKeys.length} clave(s) que algún catálogo no tiene (${unknownKeys.join(', ')}): ` +
            't() no cae al otro idioma, lanza, y el informe no llegaría a imprimirse'
        );
      }
      // EVERY key the command uses, not just the two footnotes. The list that named
      // only `balance_check` and `income_summary` let the three composed labels walk
      // back to English prose without turning anything red.
      const requiredKeys = [
        'report.total_of',
        'report.net_income',
        'report.total_liabilities_and_equity',
        'report.balance_check',
        'report.income_summary',
      ];
      const dropped = requiredKeys.filter((k) => !used.includes(k));
      if (dropped.length > 0) {
        return falla(
          `${dropped.length} rótulo(s) del informe dejaron de salir del catálogo (${dropped.join(', ')}): ` +
            'volverían a ser prosa inglesa escrita dentro del comando'
        );
      }

      // ── 2. The row travels with the KEY, never with the label ──
      if (/\bsection\.name\b/.test(cli) || /\bsub\.name\b/.test(cli)) {
        return falla('report-command.ts volvió a meter el rótulo en la fila: csv y json cambiarían con el idioma de quien lee');
      }
      if (!/section: section\.key,/.test(cli) || !/category: sub\.key,/.test(cli)) {
        return falla('las filas del informe dejaron de llevar la clave de sección o de categoría: el formato de máquina perdería su identidad');
      }

      // ── 3. The human branches label; the machine ones do not ──
      // BOTH of them: the aligned table AND markdown. `--format md -o` is what the
      // wiki teaches as the deliverable of the month, and while this guard named only
      // `toTable` that deliverable printed `assets` where the table printed «Assets».
      const labelledCalls = cli.match(/labelled: \{[^}]*\}/g) ?? [];
      if (labelledCalls.length < 2) {
        return falla(
          `sólo ${labelledCalls.length} de las dos tablas de informe recibe \`labelled\`: la otra imprimiría \`non_current_assets\` a una persona`
        );
      }
      if (!labelledCalls.every((call) => /\bsection: [A-Za-z]/.test(call) && /\bname: [A-Za-z]/.test(call))) {
        return falla('una de las dos tablas de informe ya no rotula `section` o `name`: el humano leería la clave, o un renglón de subtotal saldría en blanco');
      }
      if (!labelledCalls.some((call) => /\bcategory: [A-Za-z]/.test(call))) {
        return falla('la tabla del balance dejó de rotular `category`: las subsecciones saldrían como `long_term_liabilities`');
      }
      // And each hook reaches the catalog. A hook that is wired but writes its own
      // prose is the same defect one indirection further in.
      const hooks: [string, RegExp, string][] = [
        ['sectionOf', /reportSectionLabel\(/, 'la columna `section` de las dos tablas'],
        ['categoryOf', /reportCategoryLabel\(/, 'la columna `category` del balance'],
        ['balanceSheetName', /reportCategoryLabel\(/, 'el renglón de subtotal del balance'],
        ['incomeStatementName', /t\('report\./, 'el renglón de total del estado de resultados'],
      ];
      for (const [hook, reaches, what] of hooks) {
        const declared = declarationIn(cli, hook);
        if (declared === '') {
          return falla(`report-command.ts ya no declara ${hook}: ${what} se quedaría sin rotulador`);
        }
        if (!reaches.test(declared)) {
          return falla(`${hook} dejó de componer su prosa con el catálogo: ${what} volvería a llevar un literal inglés`);
        }
      }

      const kernel = codeOf('src/cli/kernel/output.ts');
      // A signature check would not see this: the failure mode is a parameter that is
      // received and never applied. So both halves are asked for — it reads the hook
      // (`labelled?.[…]`) and it calls it (`label(`).
      for (const [human, why] of [
        ['toTable', 'la tabla alineada'],
        ['toMarkdown', '`--format md`, que la wiki enseña como el entregable del mes'],
      ] as [string, string][]) {
        const body = declarationIn(kernel, human);
        if (!/labelled\?\.\[/.test(body) || !/\blabel\(/.test(body)) {
          return falla(
            `${human}() no recibe el gancho de rótulos o no lo aplica: ${why} imprimiría \`assets\` donde debe decir «Assets», ` +
              'con las cifras correctas al lado para que nadie sospeche'
          );
        }
      }
      for (const machine of ['toDelimited', 'jsonCell', 'cell']) {
        if (declarationIn(kernel, machine).includes('labelled')) {
          return falla(
            `${machine}() rotula: csv, tsv, ndjson y json contestarían distinto en cada idioma, que es dejar de ser formatos de máquina`
          );
        }
      }
      const composed = declarationIn(kernel, 'compose');
      const times = (composed.match(/labelled/g) ?? []).length;
      if (
        times !== 2 ||
        !/toTable\([^)]*opts\.labelled\)/.test(composed) ||
        !/toMarkdown\([^)]*opts\.labelled\)/.test(composed)
      ) {
        return falla(
          `compose() nombra \`labelled\` ${times} vez(ces) y sólo puede nombrarlo DOS: en la llamada a toTable y en la de toMarkdown. ` +
            'Rotular antes del switch de formato traduce también csv, tsv, ndjson y json; rotular en menos sitios deja a un humano leyendo claves.'
        );
      }

      // ── 4. THE INVARIANT: no service can read the language ──
      // The tree is WALKED, not a hand-written list: a list would not know about the
      // service added tomorrow, and the invariant would be lost by omission, which is
      // how invariants are lost. Three things this had to learn:
      //
      //   · ONE HOP. Matching a string in `src/services` is not the same as asking the
      //     graph. `src/types/index.ts` re-exporting `t` hands the catalog to the
      //     twenty services that import that barrel by value, and not one of them
      //     names i18n. So a file that a service imports is read too, and it counts
      //     when it RE-EXPORTS i18n — when the binding travels on.
      //     Importing i18n and keeping it is NOT the hop: `src/utils/errors.ts` does
      //     exactly that (it renders `AppError` messages, pinning English at
      //     construction and taking the language as an argument in `localized`), and
      //     108 of the 198 service files reach it. Counting a plain import would
      //     paint the invariant red for the wrong reason, and a gate that is red for
      //     the wrong reason gets deleted.
      //   · `require()` AND A COMPUTED SPECIFIER. The first loads the same module with
      //     a syntax the old pattern did not know; the second puts the path in a
      //     variable, where no text search can follow it.
      //   · `import type` IS LEFT OUT ON PURPOSE. tsc erases it: it resolves nothing
      //     at run time, so it cannot read a language. Do not "fix" this omission.
      const namesI18n = (specifiers: string[]): boolean => specifiers.some((s) => /\bi18n\b/.test(s));
      const specifiersOf = (source: string): string[] => {
        const out: string[] = [];
        for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
          const head = source.slice(0, m.index ?? 0);
          const start = Math.max(head.lastIndexOf('import'), head.lastIndexOf('export'));
          if (start >= 0 && /^(?:import|export)\s+type\b/.test(head.slice(start))) continue;
          out.push(m[1]);
        }
        for (const m of source.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
        return out;
      };
      /** Does this file hand i18n ON to whoever imports it? */
      const handsOnI18n = (source: string): boolean => {
        if (/\bexport\s+(?!type\b)[^;]*?\bfrom\s*['"][^'"]*\bi18n\b[^'"]*['"]/.test(source)) return true;
        const bound: string[] = [];
        for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\bi18n\b[^'"]*['"]/g)) {
          for (const part of m[1].split(',')) {
            const name = (part.replace(/\btype\b/, '').split(/\bas\b/).pop() ?? '').trim();
            if (name) bound.push(name);
          }
        }
        if (bound.length === 0) return false;
        return [...source.matchAll(/\bexport\s*\{([^}]*)\}/g)].some((m) =>
          m[1]
            .split(',')
            .some((p) => bound.includes(p.split(/\bas\b/)[0].replace(/\btype\b/, '').trim()))
        );
      };
      const hopTarget = (fromRel: string, specifier: string): string | null => {
        if (!specifier.startsWith('.')) return null;
        const base = path.join(path.dirname(fromRel), specifier).replace(/\.js$/, '');
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (existe(candidate)) return candidate;
        }
        return null;
      };
      const opaqueLoad = /\b(?:require|import)\s*\(\s*[^'"\s)]/;
      const seen = new Map<string, boolean>();
      const offenders: string[] = [];
      for (const file of fuentes('src/services')) {
        const rel = path.relative(RAIZ, file);
        const source = codeOf(rel);
        const specifiers = specifiersOf(source);
        if (namesI18n(specifiers)) {
          offenders.push(`${rel} (directo)`);
          continue;
        }
        if (opaqueLoad.test(source)) {
          offenders.push(`${rel} (especificador computado, que ninguna búsqueda puede seguir)`);
          continue;
        }
        for (const specifier of specifiers) {
          const target = hopTarget(rel, specifier);
          if (target === null) continue;
          if (!seen.has(target)) seen.set(target, handsOnI18n(codeOf(target)));
          if (seen.get(target) === true) {
            offenders.push(`${rel} (vía ${target})`);
            break;
          }
        }
      }
      if (offenders.length > 0) {
        return falla(
          `${offenders.length} archivo(s) de src/services alcanzan el catálogo de idioma (${offenders.slice(0, 2).join(', ')}): ` +
            'un servicio sólo puede resolver el idioma del PROCESO, así que la API contestaría siempre en él e ignoraría Accept-Language'
        );
      }

      // ── 5. The catalog covers the WHOLE domain, and the migration declares the
      // domain: a missing label does not throw —the labeller falls back to the key—
      // so nothing else would accuse it.
      const migration = 'src/database/migrations/078_lo_que_se_debe_y_todavia_no_se_paga.sql';
      if (!existe(migration)) {
        return falla(`${migration} ya no está (¿renumerada?): el catálogo de rótulos se quedaría sin dominio contra el que medirse`);
      }
      const check = sinProsa(crudoDe(migration)).match(/CHECK \(fs_category IN \(([\s\S]*?)\)\)/);
      if (!check) {
        return falla('la 078 dejó de declarar el dominio de fs_category en un CHECK: no hay contra qué medir el catálogo');
      }
      // `other` is not in the CHECK and is in the data: report-service mints it
      // for the account that has no category (`acct.fs_category || 'other'`).
      const domain = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).concat('other');
      const unlabelled = domain.filter((c) => !englishCatalog.includes(`'report.category.${c}':`));
      if (unlabelled.length > 0) {
        return falla(
          `${unlabelled.length} categoría(s) del dominio de fs_category sin rótulo en en.ts (${unlabelled.join(', ')}): ` +
            'esa subsección imprimiría su clave cruda a una persona y el rotulador no lanzaría'
        );
      }
      const keysOfLabeller = labeller.match(/REPORT_SECTION_KEYS = \[([\s\S]*?)\] as const;/);
      const sections = keysOfLabeller ? [...keysOfLabeller[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
      if (sections.length < 6) {
        return falla(`el rotulador declara ${sections.length} claves de sección y son seis: alguna quedaría sin rótulo posible`);
      }
      const unlabelledSections = sections.filter((s) => !englishCatalog.includes(`'report.section.${s}':`));
      if (unlabelledSections.length > 0) {
        return falla(`${unlabelledSections.length} sección(es) sin rótulo en en.ts (${unlabelledSections.join(', ')})`);
      }
      // The two catalogs key by key, not by count: two counts match while each side
      // is missing a different key, and `t()` throws in whichever language lacks one.
      const labelKeysOf = (catalog: string): string[] =>
        [...catalog.matchAll(/'(report\.(?:section|category)\.[a-z_]+)':/g)].map((m) => m[1]);
      const englishKeys = labelKeysOf(englishCatalog);
      const spanishKeys = labelKeysOf(spanishCatalog);
      const lopsided = [
        ...englishKeys.filter((k) => !spanishKeys.includes(k)),
        ...spanishKeys.filter((k) => !englishKeys.includes(k)),
      ];
      if (lopsided.length > 0) {
        return falla(
          `${lopsided.length} rótulo(s) de informe existen en un catálogo y no en el otro (${lopsided.slice(0, 3).join(', ')}): ` +
            'el rotulador pregunta por la clave en inglés y luego pide el texto en el idioma del lector, así que ahí lanzaría'
        );
      }
      return ok(
        `los ${domain.length} rótulos de categoría y las ${sections.length} secciones salen del catálogo en el borde; ` +
          'la tabla y el markdown rotulan, csv/tsv/ndjson/json reciben la clave, y ningún archivo de src/services alcanza el idioma'
      );
    },
  },


  // ══════════════════════════════════════════════════════════
  // A7·remate. Las tres ganancias que A7 dejó nombradas, más la que
  // apareció mirándolas: el panel se podía contestar en blanco.
  // ══════════════════════════════════════════════════════════
  {
    paquete: 'E5.1',
    id: 'eval-harness-measures-shipped-surface',
    enunciado:
      'El arnés del eval mide la superficie que se embarca, y no puede salir en verde sin haber medido',
    mutantes: [
      {
        archivo: 'scripts/eval-clasificador.ts',
        de: '          herramientas: SUPERFICIE_INGESTA,',
        a: '          // herramientas: sin lista',
        porque:
          'clasificador-más-ancho: buildTools sin lista devuelve las 25 herramientas mientras la ingesta embarca 11, así que el arnés juzgaría a un agente que nadie corre — y la cabecera del propio arnés lo prohíbe por escrito',
      },
    ],
    evaluar: () => {
      const arnes = codigoDe('scripts/eval-clasificador.ts');
      const hoja = codigoDe('src/cli/mnemosine.ts');
      // La MISMA constante en los dos sitios: el arnés no puede medir una
      // superficie que la hoja no embarca, ni al revés.
      if (!/herramientas: SUPERFICIE_INGESTA/.test(arnes)) {
        return falla('el arnés del eval abre sesión sin superficie nombrada: buildTools le daría las 25 y mediría un clasificador que la ingesta no embarca');
      }
      if (!/herramientas: SUPERFICIE_INGESTA/.test(hoja)) {
        return falla('la hoja de ingest dejó de pasar su superficie: el arnés mediría una cosa y el contador correría otra');
      }
      // El código de salida distingue «medí y salió mal» de «NO PUDE MEDIR».
      // Es la doctrina que kernel/exit.ts publica en su cabecera, y el arnés
      // salía 0 con el proveedor caído al cien por cien.
      if (!/process\.exitCode = codigoDeSalida\(/.test(arnes)) {
        return falla('el arnés dejó de fijar su salida con el veredicto: una llave caducada volvería a producir casilla verde');
      }
      if (!/EXTERNAL_FAILED/.test(arnes)) {
        return falla('el arnés perdió la rama del fallo del proveedor: «no pude mirar» volvería a contarse como «no encontré nada»');
      }
      // Y siembra el panel que el corpus declara: puntuar un caso bajo un
      // panel distinto del declarado es medir con una vara chueca.
      return /politicasRequeridas\(/.test(arnes)
        ? ok('el arnés mide la superficie embarcada, siembra el panel declarado y su salida dice si midió')
        : falla('el arnés dejó de leer las precondiciones de política del corpus: puntuaría los casos bajo el panel por omisión');
    },
  },
  {
    paquete: 'E5.1',
    id: 'batch-cfdi-scoped-and-recorded',
    enunciado:
      'Todo camino que clasifica CFDI por lotes corre con superficie recortada y deja su fila de corrida',
    mutantes: [
      {
        archivo: 'src/cli/init/s5-import.ts',
        // El ancla es el USO, no el import: quitar la línea 14 rompe la
        // compilación pero deja el nombre en la línea 121, y un criterio que
        // busca el texto lo bendecía igual. El espejo tiene que quitar la
        // CONDUCTA, no el símbolo — y este mutante lo cobró en su primera
        // corrida, que es exactamente para lo que sirve.
        de: '    herramientas: SUPERFICIE_INGESTA,',
        a: '    // sin superficie: buildTools devuelve las 25',
        porque:
          'la-clase-a-medias: se reparó la hoja de `ingest` y quedó vivo el segundo camino — el alta clasifica una carpeta entera con las 25 herramientas, brazo externo incluido, y sin dejar una sola fila de corrida',
      },
    ],
    evaluar: () => {
      // Los DOS caminos, contados. Reparar uno y dejar el otro es la instancia,
      // no la clase: `mnemosine init` clasifica por lotes igual que `ingest`.
      const caminos = [
        { rel: 'src/cli/mnemosine.ts', nombre: 'la hoja de ingest' },
        { rel: 'src/cli/init/s5-import.ts', nombre: 'el alta (init)' },
      ];
      for (const c of caminos) {
        const src = codigoDe(c.rel);
        // El CABLEADO, no el nombre. La primera versión buscaba
        // «SUPERFICIE_INGESTA» a secas y el import solo ya la satisfacía: se
        // podía borrar la línea que la PASA y el criterio seguía verde. Lo
        // cazó su propio espejo en la primera corrida, que es para lo que el
        // arnés de mutación existe.
        if (!/herramientas:\s*SUPERFICIE_INGESTA/.test(src)) {
          return falla(`${c.nombre} clasifica por lotes sin pasar su superficie: buildTools le devolvería las 25 herramientas, con el brazo externo dentro`);
        }
        if (!/conCorridaRegistrada\(/.test(src)) {
          return falla(`${c.nombre} no envuelve su bucle: una corrida que muera a media lista dejaría los borradores y cero filas de corrida`);
        }
      }
      // Y la fila se abre ANTES del bucle, que es la mitad que la 044 no tenía:
      // sin estado no se distingue «murió a medias» de «no encontró nada».
      const m = crudoDe('src/database/migrations/060_la_corrida_que_se_abre_antes.sql');
      return /status/.test(m) && /closed_at/.test(m)
        ? ok('los dos caminos de lote corren recortados y su corrida se abre antes del bucle, con estado y cierre')
        : falla('la 058 perdió el estado o el cierre de la corrida: una fila abierta para siempre es indistinguible de una corrida vacía');
    },
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

/**
 * Convierte una prueba de conducta en un criterio del tablero.
 *
 * El único trabajo real que hace es CLASIFICAR EL SILENCIO. `correrConducta`
 * devuelve `no-evaluable` cuando el escenario no se pudo montar (no hay rol
 * que cree bases, la migración no corrió) y `falla` cuando sí se montó y la
 * cifra salió mal o el camino reventó. Esa frontera es todo el contrato:
 * `bloqueadoPorEntorno` excusa de `--exigir` lo primero y no lo segundo, así
 * que ponerla en el sitio equivocado convertiría cada mutante vivo en un
 * «aquí no había instrumento».
 */
function criterioDeConducta(p: PruebaDeConducta): Criterio {
  return {
    paquete: p.paquete,
    // La prueba de conducta ya tenía id —`correrConducta` la busca por él—, así
    // que la identidad del criterio es la misma y no se inventa otra.
    id: p.id,
    enunciado: p.enunciado,
    clase: 'conducta',
    necesita: 'base-efimera',
    mutantesEnDisco: p.mutantes,
    evaluar: () => correrConducta(p.id),
  };
}
