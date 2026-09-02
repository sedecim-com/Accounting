import Decimal from 'decimal.js';
import { InvalidArgumentError, type Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { withTransaction } from '../database/connection.js';
import { DepreciationMethod } from '../types/index.js';
import {
  crearActivo,
  type ContabilizacionDelAlta,
  type DatosDeAlta,
  type ResultadoDeAlta,
} from '../services/assets/asset-service.js';
import {
  exigirLibroDelPanel,
  libroQueRige,
  resolverCategoriaDeActivo,
} from '../services/assets/asset-lookup.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  exitCodeFor,
  gateMutation,
  render,
  requireExplicitEntity,
  usageError,
  withContext,
  withNote,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine asset · activo
//
// UNA SOLA HOJA, `asset create`, y es la que abre el módulo entero: hasta hoy
// no existía un solo `INSERT INTO fixed_assets` en el repositorio, así que
// `depreciation_schedules` estaba vacía y el motor de depreciación no tenía
// nada que depreciar. Todo lo demás de la familia —`list`, `show`, `edit`,
// `category`, `disposal`— es fase 2 y no se registra aquí; inventar superficie
// que el catálogo pone en otra fase es peor que no tenerla, porque después hay
// que quitarla.
//
// CUATRO DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · EL ALTA NO POSTEA, Y POR ESO NO ES IRREVERSIBLE. El catálogo
// promete que deja «el asiento de capitalización como borrador en `mnemosine
// review`»; el servicio se niega a producirlo y tiene razón: cuando el costo
// viene de un CFDI capitalizado YA ESTÁ CARGADO a la cuenta de activo
// (cfdi-posting-plan.ts manda el rol `activo_fijo` a la 1210), de modo que un
// segundo asiento lo duplicaría; y cuando no está contabilizado, el CARGO se
// conoce pero el ABONO no —banco, cuentas por pagar o capital si fue
// aportación—, y eso el alta no lo puede adivinar. Así que `--capitalized`
// obliga a decir cuál de los dos casos es, y en el segundo el comando lo grita
// en amarillo con el importe exacto que falta llevar al mayor.
//
// LA SEGUNDA · IA ✗ AUNQUE EL CATÁLOGO DIGA ✓. Es escritura de dato maestro
// directa: `fixed_assets` no es una cola de revisión, y `declareRisk` sólo
// admite `escritura` + agente con `draftOnly`, que aquí sería mentira. Es la
// misma resolución que ya tomaron `customer create` y `invoice create` (ver
// sus cabeceras): la columna IA del catálogo es anterior a la regla del
// núcleo. El agente lee el padrón; una persona lo da de alta.
//
// LA TERCERA · `--dry-run` ENSAYA EL CAMINO REAL Y LO DESHACE. No describe a
// mano lo que pasaría: llama a `crearActivo` dentro de una transacción y la
// aborta, así que lo que se imprime sale del MISMO código que va a escribir —
// incluidas la resolución de las tres cuentas contra el catálogo de la
// entidad, la unicidad del folio y las dos políticas del panel. La alternativa
// —componer la vista previa desde las banderas— es una segunda implementación
// del alta viviendo en la capa de presentación. El folio no se quema: la serie
// es un UPSERT sobre `entity_sequences` y la reversa lo deshace, a diferencia
// de un `nextval`.
//
// LA CUARTA · `--book` DECLARA, NO ELIGE. Ver `exigirLibroDelPanel`: cuál de
// las dos depreciaciones llega al mayor es la política `base_depreciacion`, y
// una bandera que la sobreescribiera dejaría que cada orden pusiera un
// criterio contable distinto sin que nadie lo viera.
// ============================================================

export interface AssetCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
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

interface CreateOpts extends CommonOpts {
  category: string;
  cost: string;
  acquired: string;
  inService?: string;
  book?: string;
  capitalized: string;
  sourceEntry?: string;
  salvage?: string;
  lifeYears?: number;
  lifeMonths?: number;
  method?: string;
  taxMethod?: string;
  assetAccount?: string;
  accumAccount?: string;
  expenseAccount?: string;
  number?: string;
  description?: string;
  vendor?: string;
  serial?: string;
  location?: string;
  note?: string;
  dryRun?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMPORTE_RE = /^\d+(\.\d+)?$/;

/**
 * Una bandera mal escrita es error de USO (2), no una validación de dominio
 * fallida (4). La comprobación de ida y vuelta rechaza los días que no
 * existen: JavaScript acepta `2026-02-31` y lo corre al 3 de marzo, que es
 * como un activo acaba con una fecha de adquisición que nadie tecleó.
 */
export function exigirFecha(flag: string, valor: string): string {
  const d = new Date(`${valor}T00:00:00Z`);
  if (!FECHA_RE.test(valor) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw usageError(`${flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "${valor}".`);
  }
  return valor;
}

/**
 * El dinero entra y sale como CADENA, con los cuatro decimales que guarda
 * `DECIMAL(19,4)`. Aquí sólo se comprueba la forma; los CHECK del esquema
 * —costo mayor que cero, costo mayor que salvamento— los vuelve a exigir el
 * servicio, que es donde manda.
 */
export function exigirImporte(flag: string, valor: string): string {
  const limpio = valor.trim().replace(/,/g, '');
  if (!IMPORTE_RE.test(limpio)) {
    throw usageError(
      `${flag} debe ser un importe decimal sin signo; llegó "${valor}". El punto separa los ` +
        'decimales y la coma se ignora: 1,250,000.50 y 1250000.50 son lo mismo.'
    );
  }
  // Con Decimal y no con Number: un importe de nueve cifras con cuatro
  // decimales pierde precisión al pasar por un flotante, y lo que se pierde es
  // justo lo que la columna guarda.
  return new Decimal(limpio).toFixed(4);
}

function enteroPositivo(nombre: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new InvalidArgumentError(`${nombre} must be a whole number of 1 or more; got "${valor}".`);
    }
    return n;
  };
}

const METODOS = Object.values(DepreciationMethod);

/**
 * El método, del vocabulario que la 056 puso en el CHECK. Se valida aquí para
 * que un typo salga como uso y no como un error de Postgres nombrando una
 * restricción.
 */
export function exigirMetodo(flag: string, valor: string): DepreciationMethod {
  const m = valor.trim().toLowerCase();
  if (!(METODOS as string[]).includes(m)) {
    throw usageError(`${flag} "${valor}" no existe. Los seis métodos son: ${METODOS.join(', ')}.`);
  }
  return m as DepreciationMethod;
}

/**
 * DÓNDE ESTÁ YA EL COSTO. Sin valor por omisión a propósito: suponerlo
 * duplica el activo en el mayor o lo deja fuera de él, y las dos cosas se
 * descubren meses después.
 */
export function exigirContabilizacion(valor: string): ContabilizacionDelAlta {
  const v = valor.trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'si' || v === 'sí') return 'ya_contabilizado';
  if (v === 'no' || v === 'n') return 'sin_contabilizar';
  throw usageError(
    `--capitalized "${valor}" no se entiende: es yes cuando el costo YA está cargado a la cuenta ` +
      'de activo en el mayor (el CFDI que se capitalizó), y no cuando el alta sólo registra el ' +
      'bien y el asiento está pendiente. No tiene valor por omisión: suponerlo duplica el activo ' +
      'o lo deja fuera del mayor.'
  );
}

/** El acto ensayado: se lanza para abortar la transacción del ensayo. */
class EnsayoDeAlta extends Error {
  constructor(readonly resultado: ResultadoDeAlta) {
    super('ensayo de alta terminado');
    this.name = 'EnsayoDeAlta';
  }
}

export function registerAssetCommand(program: Command, deps: AssetCommandDeps): void {
  const asset = program
    .command('asset')
    .alias('activo')
    .description('Fixed asset register: the ledger of what the company owns and depreciates');

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

  // ---- asset create --------------------------------------------------
  const create = asset
    .command('create')
    .alias('crear')
    .argument('<name>', 'what the asset is called in the register')
    .description(
      'Register a fixed asset with its class, dates, cost and accounts — writes no journal entry'
    );
  withContext(create);
  withOutput(create);
  withNote(create);
  create
    .option('--category <idOrName>', 'asset class: its id, or enough of its name to be unambiguous')
    .option('--cost <amount>', 'original cost of the investment (MOI), as a decimal')
    .option('--acquired <date>', 'acquisition date (YYYY-MM-DD)')
    .option(
      '--in-service <date>',
      'date depreciation starts (YYYY-MM-DD); defaults from the first-month convention on the panel'
    )
    .option('--book <book|tax>', 'the depreciation book you believe you are working on; checked against the panel')
    .option(
      '--capitalized <yes|no>',
      'whether the cost is ALREADY charged to the asset account in the ledger — no default'
    )
    .option('--source-entry <id>', 'the journal entry the cost already sits in, when it is known')
    .option('--salvage <amount>', 'residual value at the end of its life (default 0)')
    .option('--life-years <n>', 'useful life in years', enteroPositivo('--life-years'))
    .option(
      '--life-months <n>',
      'useful life in months; years are the ceiling of months over twelve',
      enteroPositivo('--life-months')
    )
    .option('--method <method>', `BOOK depreciation method: ${METODOS.join(', ')}`)
    .option('--tax-method <method>', `TAX depreciation method: ${METODOS.join(', ')}`)
    .option('--asset-account <id>', 'GL account the cost sits in (defaults from the class)')
    .option('--accum-account <id>', 'accumulated depreciation account (defaults from the class)')
    .option('--expense-account <id>', 'depreciation expense account (defaults from the class)')
    .option('--number <folio>', 'asset number; generated from the entity series when omitted')
    .option('--description <text>', 'what the asset is')
    .option('--vendor <id>', 'vendor it was bought from')
    .option('--serial <text>', 'serial number, so the register can find the physical thing')
    .option('--location <text>', 'where it is')
    .option('--dry-run', 'run the real path and undo it: shows the asset that would be created');
  // ESCRITURA de dato maestro, y el agente NO puede llamarla. El catálogo la
  // marca IA ✓, pero `fixed_assets` no es una cola de revisión y `declareRisk`
  // sólo admite escritura + agente con `draftOnly`, que aquí sería mentira.
  // Misma resolución que `customer create` e `invoice create`.
  declareRisk(create, {
    risk: 'escritura',
    agent: false,
    writes: 'fixed_assets (alta) + entity_sequences (folio) + audit_log; ninguna póliza',
  });
  create.action((nombre: string, opts: CreateOpts, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);

      // Las tres obligatorias se comprueban ANTES de gastar una conexión, y se
      // nombran las tres juntas: pedirlas de una en una obliga a tres viajes.
      const faltantes = [
        opts.category ? null : '--category',
        opts.cost ? null : '--cost',
        opts.acquired ? null : '--acquired',
        opts.capitalized ? null : '--capitalized',
      ].filter((f): f is string => f !== null);
      if (faltantes.length > 0) {
        throw usageError(
          `Faltan ${faltantes.join(', ')}. Un activo sin clase, sin costo, sin fecha de ` +
            'adquisición o sin decir dónde está ya su costo no es una ficha incompleta: es una ' +
            'ficha que no se puede depreciar ni cuadrar contra el mayor.'
        );
      }

      const contabilizacion = exigirContabilizacion(opts.capitalized);
      const adquisicion = exigirFecha('--acquired', opts.acquired);
      const enServicio =
        opts.inService === undefined ? undefined : exigirFecha('--in-service', opts.inService);
      const costo = exigirImporte('--cost', opts.cost);
      const salvamento = opts.salvage === undefined ? undefined : exigirImporte('--salvage', opts.salvage);
      const metodoContable = opts.method === undefined ? undefined : exigirMetodo('--method', opts.method);
      const metodoFiscal =
        opts.taxMethod === undefined ? undefined : exigirMetodo('--tax-method', opts.taxMethod);

      if (opts.sourceEntry !== undefined && contabilizacion === 'sin_contabilizar') {
        throw usageError(
          '--source-entry nombra el asiento donde YA está el costo, así que no se puede pasar ' +
            'junto a `--capitalized no`, que afirma lo contrario. Decide cuál de las dos es cierta.'
        );
      }

      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      // El libro que rige sale del panel; la bandera sólo puede coincidir.
      const vigente = await libroQueRige(ctx.tenantId, ctx.entityId);
      const libro = exigirLibroDelPanel(opts.book, vigente);

      const categoria = await resolverCategoriaDeActivo(ctx.entityId, opts.category);

      const datos: DatosDeAlta = {
        asset_name: nombre,
        category_id: categoria.id,
        acquisition_date: adquisicion,
        acquisition_cost: costo,
        contabilizacion,
        asset_number: opts.number,
        description: opts.description ?? null,
        salvage_value: salvamento,
        useful_life_years: opts.lifeYears,
        useful_life_months: opts.lifeMonths,
        depreciation_start_date: enServicio,
        book_depreciation_method: metodoContable,
        tax_depreciation_method: metodoFiscal,
        asset_account_id: opts.assetAccount,
        accumulated_depreciation_account_id: opts.accumAccount,
        depreciation_expense_account_id: opts.expenseAccount,
        vendor_id: opts.vendor ?? null,
        serial_number: opts.serial ?? null,
        location: opts.location ?? null,
        notes: opts.note ?? null,
        asiento_de_origen_id: opts.sourceEntry ?? null,
      };

      let alta: ResultadoDeAlta;
      if (dryRun) {
        // EL CAMINO REAL, DESHECHO. Lo que se imprime sale del mismo código
        // que escribiría, con sus comprobaciones de cuenta, de folio y de
        // panel; la transacción se aborta con un centinela para que nada
        // quede — ni la fila, ni el folio, ni la bitácora.
        try {
          alta = await withTransaction(async (client) => {
            const r = await crearActivo(ctx.entityId, datos, reviewer.userId, { client });
            throw new EnsayoDeAlta(r);
          });
        } catch (err) {
          if (!(err instanceof EnsayoDeAlta)) throw err;
          alta = err.resultado;
        }
      } else {
        alta = await crearActivo(ctx.entityId, datos, reviewer.userId);
      }

      const fila: Row = {
        id: alta.id,
        asset_number: alta.asset_number,
        asset_name: alta.asset_name,
        categoria: categoria.name,
        acquisition_cost: alta.acquisition_cost,
        current_book_value: alta.current_book_value,
        useful_life_months: alta.useful_life_months,
        metodo: alta.depreciation_method,
        libro,
        depreciation_start_date: alta.depreciation_start_date,
        base_depreciacion: alta.politicas.base_depreciacion,
        convencion_primer_mes: alta.politicas.convencion_primer_mes,
        contabilizacion,
      };
      // `--fields` se honra en la salida por omisión y no sólo en --json: es
      // `render` quien lo aplica, y por eso la ficha va por aquí en vez de
      // imprimirse a mano.
      render([fila], { ...opts, idField: 'id', numeric: ['acquisition_cost', 'current_book_value'] });

      const err = process.stderr;
      if (dryRun) {
        err.write(deps.palette.dim('Ensayo: la transacción se deshizo. No se creó ningún activo.\n'));
      }
      for (const aviso of alta.avisos) {
        err.write(deps.palette.yellow(`  ⚠ ${aviso}\n`));
      }
      return ExitCode.OK;
    })
  );
}
