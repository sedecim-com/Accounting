import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Decimal from 'decimal.js';
import type { Command } from 'commander';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { conLlave, mirarLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { query } from '../database/connection.js';
import {
  cuentasDeProvisiones,
  declararPtu,
  planMonthlyProvisions,
  runMonthlyProvisions,
  type CriteriosDeProvision,
  type ProvisionPlan,
  type ProvisionPlanRow,
  type ProvisionPlanSkip,
} from '../services/accruals/provisions-run.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  dateOnly,
  declareRisk,
  exitCodeFor,
  gateMutation,
  legible,
  render,
  requireExplicitEntity,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine payroll · nomina
//
// LA PUERTA DEL DEVENGO DE PRESTACIONES. El motor de la NIF D-3 —aguinaldo
// (LFT 87), vacaciones (76) y prima vacacional (80), devengados por día
// trabajado— existía entero, probado y sin UNA SOLA forma de invocarlo: la
// revisión independiente del PR #180 lo marcó crítico, y este repositorio hasta
// tiene nombre para eso —capacidad huérfana— y un chequeo de `doctor` que la
// busca. Un motor inalcanzable no es una función a medias: en producción el
// pasivo de aguinaldo NO se reconoce ningún mes, el resultado de once meses
// sale inflado y el de diciembre catastrófico, y ninguno de los doce estados es
// firmable. La corrida gemela —la amortización de anticipados— sí tenía la
// suya (`prepaid run`) desde D1a; ésta es la que faltaba.
//
// EL NOMBRE NO SE ELIGIÓ AQUÍ. `payroll accrue`·`nomina devengar` lo fija el
// registro de comandos (docs/cli-command-registry.md, dictámenes 28 y 39):
// `provision`·`provision` está adjudicado a fiscal-us —la provisión del
// impuesto corporativo, que es otra cosa— y el devengo de nómina se nombra con
// el verbo `accrue`, que ya vive en la lista cerrada de `vocabulary.ts`. La
// fila también estaba escrita desde antes en el catálogo (§5.29).
//
// CINCO DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · SIN `--period` NO SE ASUME «EL ACTUAL», igual que en la hoja
// gemela y por su misma razón, que aquí vale más todavía: correr «el periodo
// actual» un día 1 a las 00:05 devengaría el mes que acaba de empezar, y el
// mayor no admite deshacer. El mes se teclea.
//
// LA SEGUNDA · ES IRREVERSIBLE Y POR TANTO IA ✗. Postea al mayor de la 041,
// donde un asiento no se edita ni se borra: se corrige por reversa. El núcleo
// le inyecta `--dry-run`, `--yes` e `--idempotency-key`, y `declareRisk`
// REHÚSA arrancar si alguien intenta darle acceso al agente.
//
// LA TERCERA · LA PREVIA NO ES UNA SEGUNDA IMPLEMENTACIÓN. La hoja de la
// amortización tuvo que reproducir su corrida con las funciones puras del motor
// y lo dejó escrito: «queda un cálculo repetido», y por eso compara al final.
// Aquí no: `planMonthlyProvisions` es la MISMA función que usa
// `runMonthlyProvisions`, así que lo que el ensayo enseña es literalmente lo
// que la corrida postearía. Lo que sigue sin poder prometerse es que el mundo
// no cambie entre mirar y postear —un alta, una respuesta del panel—, y de eso
// sí se ocupa la comparación de después.
//
// LA CUARTA · ES UN SOLO ASIENTO, NO UNO POR TRABAJADOR — al revés que la
// amortización, que crea uno por anticipo. Una plantilla de doscientas personas
// produciría doscientos asientos idénticos en fecha y concepto, y el mayor de
// diciembre sería ilegible. El desglose por persona es la CÉDULA
// (`benefit_provision_schedules`), y por eso la vista previa enseña las dos
// cosas: la cédula, que es de quién es cada peso, y el asiento, que es lo que
// entra al libro.
//
// LA QUINTA · LO QUE ESTA HOJA NO REHACE, Y CONFÍA. La idempotencia por
// entidad-periodo, el rechazo del periodo 13 y que sin trabajadores no se
// postee nada son reglas del DEVENGO y viven en el motor. Copiarlas aquí sería
// fabricar una segunda versión de cada una con licencia para contradecirla; lo
// que la hoja hace es llamarlas y contar lo que contestan.
// ============================================================

export interface PayrollCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de `payroll accrue`. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

/**
 * El mes se teclea, y esta función es la que se niega a adivinarlo.
 *
 * Es gemela de `exigirPeriodo` en prepaid-command.ts y no se comparte con ella
 * a propósito: lo único que tiene dentro es el MENSAJE, y el mensaje lo lee un
 * operador que está devengando la nómina. Decirle que «la amortización es de un
 * mes concreto» lo manda a buscar el defecto al módulo equivocado — la misma
 * razón por la que `periodoDeLaCorrida` recibe el nombre del motor.
 */
export function requirePeriod(periodo: string | undefined): string {
  if (!periodo) {
    throw usageError(
      'Falta --period. El devengo de prestaciones es de un mes concreto y no se adivina del ' +
        'reloj: correr «el periodo actual» un día 1 a las 00:05 devengaría el mes que acaba de ' +
        'empezar, y el asiento no se puede borrar después (mnemosine period list enumera los ' +
        'periodos de la entidad).'
    );
  }
  return periodo;
}

// ---- Las filas que se imprimen ------------------------------------------

/**
 * LA CÉDULA: un renglón por trabajador, entre o no, con su motivo.
 *
 * Los omitidos salen NOMBRADOS y no como un número al pie. Los dos motivos son
 * legítimos y significan cosas distintas —«este mes ya se devengó» y «su
 * aritmética dio cero»—, y un contador que ve a alguien fuera de la cédula
 * necesita saber cuál de los dos le tocó sin volver a consultar la base.
 */
export function filasDeLaCedula(plan: ProvisionPlan): Row[] {
  const entra = (r: ProvisionPlanRow): Row => ({
    empleado: r.worker.employee_number,
    nombre: r.worker.nombre,
    estado: 'devenga',
    motivo: '',
    dias: r.provision.dias_devengados,
    aguinaldo: r.provision.aguinaldo,
    vacaciones: r.provision.vacaciones,
    prima_vacacional: r.provision.prima_vacacional,
    total: new Decimal(r.provision.aguinaldo)
      .plus(r.provision.vacaciones)
      .plus(r.provision.prima_vacacional)
      .toFixed(4),
  });
  const omite = (s: ProvisionPlanSkip): Row => ({
    empleado: s.worker.employee_number,
    nombre: s.worker.nombre,
    estado: 'omitido',
    motivo:
      s.reason === 'already-accrued'
        ? 'ya tiene renglon vigente de este mes'
        : 'su devengo del mes es cero',
    dias: '',
    aguinaldo: '',
    vacaciones: '',
    prima_vacacional: '',
    total: '',
  });
  return [...plan.rows.map(entra), ...plan.skipped.map(omite)];
}

/**
 * EL ASIENTO, ANTES DE CREARLO.
 *
 * Las descripciones y el reparto de líneas son LITERALMENTE los que escribe
 * `runMonthlyProvisions`: cargo único a la cuenta de gasto por el total, y un
 * abono por concepto —saltando el que valga cero, porque los CHECK de
 * `journal_entry_lines` exigen importes estrictamente positivos y bajo la
 * convención `aniversario` las vacaciones valen cero once meses de cada doce—.
 * Si esto no fuera lo que quedará en el libro, la previa sería decoración.
 */
export function filasDelAsiento(
  plan: ProvisionPlan,
  cuenta: (id: string) => string,
  cuentas: { gasto: string; aguinaldo: string; vacaciones: string; prima_vacacional: string }
): Row[] {
  const fecha = dateOnly(plan.periodo.fin);
  const filas: Row[] = [
    {
      linea: 1,
      fecha,
      cuenta: cuenta(cuentas.gasto),
      descripcion: `Benefit provisions - ${plan.rows.length} employee(s)`,
      debe: plan.total,
      haber: '',
    },
  ];
  const abono = (id: string, descripcion: string, importe: string): void => {
    if (new Decimal(importe).isZero()) return;
    filas.push({
      linea: filas.length + 1,
      fecha,
      cuenta: cuenta(id),
      descripcion,
      debe: '',
      haber: importe,
    });
  };
  abono(cuentas.aguinaldo, 'Aguinaldo accrual (LFT art. 87)', plan.aguinaldo);
  abono(cuentas.vacaciones, 'Vacation accrual (LFT art. 76)', plan.vacaciones);
  abono(cuentas.prima_vacacional, 'Vacation premium accrual (LFT art. 80)', plan.prima_vacacional);
  return filas;
}

/** El panel que gobernó el importe, y si alguien lo contestó de verdad. */
export function criteriosParaLeer(c: CriteriosDeProvision): Record<string, unknown> {
  const con = (clave: string, valor: string | number): Record<string, unknown> => ({
    valor,
    definida: c.definidas[clave] === true,
  });
  return {
    provision_base_salarial: con('provision_base_salarial', c.base_salarial),
    devengo_vacaciones: con('devengo_vacaciones', c.convencion_vacaciones),
    dias_aguinaldo: con('dias_aguinaldo', c.dias_aguinaldo),
    prima_vacacional_pct: con('prima_vacacional_pct', c.prima_vacacional_pct),
    provision_ptu_mensual: con('provision_ptu_mensual', c.ptu_mensual),
  };
}

// ============================================================
// EJEMPLOS DE AYUDA. Invocaciones copiables, no plantillas: cada una parsea
// contra el commander embarcado (lo comprueba tests/cli/ejemplos-de-ayuda.spec.ts).
// La prosa va en inglés, que es el idioma del nodo; los datos son mexicanos.
// ============================================================
const EJEMPLOS = {
  accrue: `
Examples:
  # ALWAYS this one first: the accrual is irreversible, and --dry-run shows the
  # whole schedule -- who accrues, how many days, how much per benefit -- and
  # the entry it would post, writing nothing.
  mnemosine payroll accrue --period 2026-03 --dry-run
  # The real run, with a key: a retry after a dropped connection returns the
  # recorded result instead of accruing the month twice.
  mnemosine payroll accrue --period 2026-03 --yes --idempotency-key devengo-2026-03
`,
};
/** Lo que `conLlave` graba de una corrida de devengo. */
interface ResultadoGrabado extends Record<string, unknown> {
  processed: number;
  skipped: number;
  total: string;
  errors: string[];
  journalEntryId: string | null;
}

/**
 * ¿El asiento que aquella corrida posteó SIGUE EN PIE?
 *
 * Es el mismo predicado que `RENGLON_VIGENTE` aplica a la cédula: posteado y
 * sin reversa. Un resultado grabado cuyo asiento se reversó ya no describe el
 * mundo, y reproducirlo diría que el mes está devengado cuando no lo está.
 */
async function asientoVigente(id: string): Promise<boolean> {
  const r = await query<{ uno: number }>(
    `SELECT 1 AS uno FROM journal_entries
      WHERE id = $1 AND status = 'posted' AND reversed_by_entry_id IS NULL`,
    [id]
  );
  return r.rows.length > 0;
}


export function registerPayrollCommand(program: Command, deps: PayrollCommandDeps): void {
  const payroll = program
    .command('payroll')
    .alias('nomina')
    .description('Payroll accounting: the benefit liability that is born on the day worked');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  /** Una escritura no adivina la entidad: la nombra o la tiene fijada. */
  const entityForWrite = async (opts: CommonOpts) => {
    // Inquilino PRIMERO: la resolución de entidad va acotada por RLS, así que
    // un --tenant aplicado después no resuelve nada.
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      // Por el kernel: la gramática de «sí» es una sola en todo el CLI y
      // entiende los dos idiomas. Una escrita a mano aquí volvería a contar
      // como NO un «sí» tecleado en español.
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        deps.palette.cyan(`${question} [y/N] `)
      );
      if (veredicto.incomprendida !== undefined) {
        process.stderr.write(`${noEntendi(veredicto.incomprendida)}; lo tomo como no.\n`);
      }
      return veredicto.si;
    } finally {
      rl.close();
    }
  };

  // ---- payroll accrue --------------------------------------------------
  const devengar = payroll
    .command('accrue')
    .alias('devengar')
    .description(
      'Post the month benefit accrual -- aguinaldo, vacation and vacation premium, one adjusting entry, irreversible'
    );
  withContext(devengar);
  withOutput(devengar);
  devengar.option('--period <expr>', 'period to accrue: 2026-03, or any unambiguous part of its name');
  // IRREVERSIBLE: postea al mayor de la 041, donde un asiento no se edita ni se
  // borra. El núcleo inyecta --dry-run, --yes e --idempotency-key, y
  // `declareRisk` REHÚSA arrancar si alguien intenta darle acceso al agente.
  //
  // LA LLAVE SE HONRA, y se declara para que se pueda comprobar: el ámbito que
  // aquí se escribe es el que el manejador entrega a `conLlave`, y R11 cruza las
  // dos cosas contra el fuente (tests/cli/kernel/llave-honrada.spec.ts). Una
  // hoja que acepta la bandera sin declararla promete una deduplicación que
  // nadie ha comprobado.
  declareRisk(devengar, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines (UN asiento de ajuste por corrida), ' +
      'benefit_provision_schedules (un renglon de cedula por trabajador)',
    llave: { scope: 'payroll accrue' },
  });
  devengar.addHelpText('after', EJEMPLOS.accrue);
  devengar.action((
    opts: CommonOpts & {
      period?: string;
      dryRun?: boolean;
      yes?: boolean;
      idempotencyKey?: string;
    },
    cmd: Command
  ) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const periodo = await resolvePeriod(ctx.entityId, requirePeriod(opts.period));

      // LA CÉDULA, CALCULADA SIN ESCRIBIR. Es la misma función que la corrida
      // usa para decidir qué postea, no una reconstrucción suya: ver la TERCERA
      // decisión de la cabecera.
      const plan = await planMonthlyProvisions(ctx.entityId, periodo.id);
      const total = new Decimal(plan.total);
      const previstos = plan.rows.length;

      // Las cuentas se resuelven a CÓDIGO —un asiento que enseña UUIDs no se
      // puede revisar— y sólo cuando hay algo que postear: una entidad sin
      // nómina mexicana no tiene por qué fallar por cuatro roles que no va a
      // usar, que es exactamente lo que el motor decidió.
      const cuentas = previstos > 0 ? await cuentasDeProvisiones(ctx.entityId) : null;
      const codigos = new Map<string, string>();
      if (cuentas) {
        // Las cuatro se nombran una a una y no con `Object.values`: sobre una
        // interfaz sin índice ese ayudante devuelve `any[]`, y un id de cuenta
        // que viaja como `any` hasta una consulta es justo lo que el lint con
        // información de tipos existe para no dejar pasar.
        const ids = [cuentas.gasto, cuentas.aguinaldo, cuentas.vacaciones, cuentas.prima_vacacional];
        for (const id of new Set(ids)) {
          const cuenta = await resolveAccount(ctx.entityId, id);
          codigos.set(id, `${cuenta.code} ${cuenta.name}`);
        }
      }
      const asiento =
        cuentas === null ? [] : filasDelAsiento(plan, (id) => codigos.get(id) ?? id, cuentas);

      const err = process.stderr;
      err.write(
        deps.palette.dim(
          `${plan.periodo.nombre} (${dateOnly(plan.periodo.inicio)}..${dateOnly(plan.periodo.fin)}) · ` +
            `asiento con fecha ${dateOnly(plan.periodo.fin)} · ${previstos} trabajador(es) devengan, ` +
            `${plan.skipped.length} se omiten · aguinaldo ${plan.aguinaldo} · vacaciones ` +
            `${plan.vacaciones} · prima ${plan.prima_vacacional} · total ${plan.total}\n`
        )
      );
      err.write(
        deps.palette.dim(
          `base ${plan.criterios.base_salarial}` +
            `${plan.criterios.definidas.provision_base_salarial ? '' : ' (defecto)'} · ` +
            `vacaciones ${plan.criterios.convencion_vacaciones}` +
            `${plan.criterios.definidas.devengo_vacaciones ? '' : ' (defecto)'} · ` +
            `aguinaldo ${plan.criterios.dias_aguinaldo} dia(s) · ` +
            `prima ${plan.criterios.prima_vacacional_pct}\n`
        )
      );
      if (!plan.criterios.definidas.provision_base_salarial || !plan.criterios.definidas.devengo_vacaciones) {
        err.write(
          deps.palette.yellow(
            '  ⚠ Rige al menos un defecto declarado y no una elección del despacho: entre ' +
              '`nominal` e `integrado` hay un 20 % de diferencia en el importe de cada mes. Se ' +
              'contesta con `mnemosine pending resolve provision_base_salarial` / ' +
              '`devengo_vacaciones`.\n'
          )
        );
      }

      // LA PTU, DECLARADA ANTES DE POSTEAR Y NO DESPUÉS.
      //
      // Un cero silencioso y una ausencia declarada no son lo mismo: la 2205 no
      // se toca, y el operador tiene que poder leer POR QUÉ mientras todavía
      // está mirando el ensayo. La nota la escribe el motor —es una afirmación
      // legal (LFT 120)— y aquí sólo se enseña.
      const ptu = declararPtu(plan.criterios.ptu_mensual);

      // EN MODO MÁQUINA, UN SOLO DOCUMENTO. Dos `render` seguidos con --json
      // escriben dos sobres pegados y `JSON.parse` revienta; con `-o` la
      // segunda tabla se acumula sobre la primera y el archivo deja de ser
      // legible por una máquina. Mismo remedio que `cfdi show`: la cédula y el
      // asiento viajan anidados dentro de un documento.
      if (!legible(opts)) {
        render(
          [
            {
              periodo: plan.periodo.nombre,
              fecha_del_asiento: dateOnly(plan.periodo.fin),
              devengan: previstos,
              omitidos: plan.skipped.length,
              aguinaldo: plan.aguinaldo,
              vacaciones: plan.vacaciones,
              prima_vacacional: plan.prima_vacacional,
              total: plan.total,
              dry_run: dryRun === true,
              criterios: criteriosParaLeer(plan.criterios),
              ptu,
              cedula: filasDeLaCedula(plan),
              asiento,
              errores: plan.errors,
            },
          ],
          { ...opts, idField: 'periodo' }
        );
      } else {
        render(filasDeLaCedula(plan), {
          ...opts,
          idField: 'empleado',
          numeric: ['dias', 'aguinaldo', 'vacaciones', 'prima_vacacional', 'total'],
        });
        if (asiento.length > 0) {
          err.write(deps.palette.dim(`El asiento unico de la corrida, ${asiento.length} linea(s):\n`));
          render(asiento, { ...opts, idField: 'linea', numeric: ['debe', 'haber'] });
        }
        for (const e of plan.errors) err.write(deps.palette.yellow(`  ⚠ ${e}\n`));
        err.write(deps.palette.dim(`PTU: ${ptu.nota}\n`));
      }

      // ── LA LLAVE SE MIRA ANTES DE TRABAJAR (WIT-180-02) ────────────────
      //
      // `conLlave` envuelve el acto, así que sólo se consultaba cuando el
      // manejador llegaba hasta él — y aquí no llegaba: un reintento encuentra
      // el mes YA devengado, `trabajadoresYaProvisionados` manda a todos a
      // `skipped`, `previstos` queda en cero, y la hoja salía por la puerta de
      // abajo con «Nada que devengar» y total 0.0000. Es decir: la promesa que
      // la ayuda de esta hoja publica —«un reintento tras perder la conexión
      // devuelve el resultado grabado»— era falsa justo en el ÚNICO caso en que
      // alguien reintenta.
      //
      // `mirarLlave` existe para esto y lo dice en su cabecera: las hojas de
      // cobro y pago tenían el mismo defecto con su compuerta de saldo. Es una
      // lectura: no consuma la llave, no arbitra carreras —de eso sigue
      // encargándose `conLlave` con su restricción única— y sólo permite
      // contestar antes de tocar el dominio. Una llave con OTRA carga sigue
      // saliendo en conflicto, que es la acusación de reuso.
      // LA CARGA ES LA ORDEN, NO SU RESULTADO (WIT-180-02).
      //
      // Antes incluía `previstos` y `plan.total`, con el argumento de que
      // «reintentar la misma orden sobre otros importes no es un reintento».
      // El argumento suena bien y hacía la llave IMPOSIBLE DE CASAR: esas dos
      // cifras son el resultado del estado actual, no de la petición, y
      // colapsan a cero en el reintento —precisamente porque la primera
      // corrida funcionó y el motor ya no ve a nadie por devengar—. El hash del
      // reintento nunca era el de la corrida grabada.
      //
      // La orden es «devenga este periodo de esta entidad», y eso es lo que
      // identifica el acto. La misma llave sobre OTRO periodo sigue siendo
      // reuso y sigue saliendo en conflicto, que es lo que la llave tiene que
      // acusar.
      const llave = {
        scope: 'payroll accrue',
        clave: opts.idempotencyKey,
        payloadHash: hashDeCarga(ctx.entityId, plan.periodo.id),
      };
      const grabado = await mirarLlave<ResultadoGrabado>({ tenantId: ctx.tenantId }, llave);
      if (grabado !== undefined) {
        // Y NO SE REPRODUCE UN RESULTADO QUE YA NO ES VERDAD. Si el asiento que
        // aquella corrida posteó fue REVERSADO, devolverlo diría «✔ devengados»
        // con el id de un asiento anulado, y el mes seguiría sin devengar. El
        // motor está hecho para que una reversa permita volver a correr —«una
        // reversa es una corrección, no una condena»—, así que aquí se acusa en
        // vez de mentir: con una llave nueva, el mes se devenga otra vez.
        if (grabado.journalEntryId !== null && !(await asientoVigente(grabado.journalEntryId))) {
          throw usageError(
            `La llave "${opts.idempotencyKey ?? ''}" grabó el asiento ${grabado.journalEntryId}, que ` +
              `después se reversó. Devolver ese resultado diría que el mes está devengado cuando no ` +
              `lo está. Vuelve a correr con una llave nueva —es otra corrida, no un reintento— o sin ` +
              `--idempotency-key.`
          );
        }
        err.write(
          deps.palette.dim(
            'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió ' +
              'a devengar.\n'
          )
        );
        render(
          [
            {
              devengan: grabado.processed,
              omitidos: grabado.skipped,
              total: grabado.total,
              asiento: grabado.journalEntryId ?? '—',
            },
          ],
          { ...opts, idField: 'asiento', numeric: ['total'] }
        );
        return ExitCode.OK;
      }

      if (previstos === 0) {
        err.write(
          deps.palette.dim(
            `Nada que devengar en ${plan.periodo.nombre}: el mayor no se tocó y no se escribió ` +
              'ningún renglón de cédula.\n'
          )
        );
        // Una ficha rota no impide que los demás devenguen, pero tampoco se
        // calla: si TODO lo que había eran fichas rotas, el mes queda sin
        // devengar y el código de salida tiene que decirlo.
        return plan.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
      }

      if (dryRun) {
        err.write(
          deps.palette.dim('Ensayo: el mayor no se tocó y no se escribió ningún renglón de cédula.\n')
        );
        // EL ENSAYO SALE CON EL CÓDIGO QUE SALDRÍA LA CORRIDA, y no siempre 0.
        //
        // El ensayo existe para que un guion pueda mirar antes de postear, y un
        // guion mira el CÓDIGO DE SALIDA: la advertencia de una ficha rota va a
        // stderr, que es justo lo que un `if mnemosine … --dry-run; then` no
        // lee. Devolver 0 aquí decía «todo en orden» de un mes en el que la
        // corrida iba a salir 4 —lo comprobado: con un trabajador 'terminated'
        // sin fecha de baja, ensayo 0 y corrida 4—, y la promesa de esta hoja
        // es que el ensayo enseñe lo que va a pasar, el código incluido.
        //
        // Es además la misma regla que la rama de arriba ya aplicaba dos líneas
        // antes sin mirar `dryRun`: un mes con TODAS las fichas rotas salía 4
        // en ensayo, y uno con una sola rota salía 0. La misma condición no
        // puede tener dos respuestas en el mismo manejador.
        return plan.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
      }

      if (opts.yes !== true) {
        const ok = await ask(
          `¿Devengar ${total.toFixed(2)} MXN de ${previstos} trabajador(es) en ${plan.periodo.nombre}? ` +
            'El mayor no admite deshacer.'
        );
        if (!ok) {
          throw abortedByUser(
            stdin.isTTY
              ? 'Sin cambios: el mayor no se tocó.'
              : 'Sin cambios: no hay terminal donde confirmar. Añade -y para devengar sin ' +
                'preguntar, o --dry-run para ver la cédula completa sin escribir nada.'
          );
        }
      }

      // `--idempotency-key`, HONRADA. La misma llave con la misma carga
      // devuelve el resultado GRABADO sin volver a correr. La carga incluye el
      // total previsto: reintentar la misma orden sobre otros importes no es un
      // reintento, es otra corrida.
      const { repetido, resultado } = await conLlave<{
        processed: number;
        skipped: number;
        total: string;
        errors: string[];
        journalEntryId: string | null;
      }>(
        { tenantId: ctx.tenantId, entityId: ctx.entityId },
        llave,
        async () => {
          const r = await runMonthlyProvisions(ctx.entityId, plan.periodo.id, reviewer.userId);
          // Se copia a un objeto llano porque `conLlave` lo guarda como JSON y
          // su firma lo exige indexable; `ResultadoDeProvisiones` es una interfaz
          // y no lleva índice implícito.
          return {
            processed: r.processed,
            skipped: r.skipped,
            total: r.total,
            errors: r.errors,
            journalEntryId: r.journalEntryId,
          };
        }
      );

      if (repetido) {
        err.write(
          deps.palette.dim(
            'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió ' +
              'a devengar.\n'
          )
        );
      }

      // LA COMPARACIÓN CONTRA LO QUE DE VERDAD PASÓ. La previa y la corrida
      // comparten la función que arma la cédula, así que aquí no se vigila una
      // divergencia de código: se vigila que el MUNDO no haya cambiado entre
      // mirar y postear —un alta, una baja, alguien contestando el panel—, que
      // es lo único que un ensayo no puede prometer.
      if (!repetido && resultado.processed !== previstos) {
        err.write(
          deps.palette.yellow(
            `  ⚠ La vista previa enseñaba ${previstos} trabajador(es) y la corrida devengó ` +
              `${resultado.processed}. Algo cambió entre mirar y postear: revisa la cédula antes ` +
              'de dar el mes por cerrado.\n'
          )
        );
      }
      if (!repetido && !new Decimal(resultado.total).equals(total)) {
        err.write(
          deps.palette.yellow(
            `  ⚠ La vista previa sumaba ${plan.total} y la corrida devengó ${resultado.total}.\n`
          )
        );
      }
      for (const e of resultado.errors) err.write(deps.palette.yellow(`  ⚠ ${e}\n`));
      err.write(
        deps.palette.green(
          `✔ ${resultado.processed} trabajador(es) devengados en ${plan.periodo.nombre} por ` +
            `${resultado.total}` +
            `${resultado.journalEntryId ? ` · asiento ${resultado.journalEntryId}` : ''}.\n`
        )
      );

      return resultado.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
    })
  );
}
