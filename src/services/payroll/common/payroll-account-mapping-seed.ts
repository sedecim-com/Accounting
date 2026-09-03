import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '../../../database/connection.js';

// ============================================================
// SEED OF THE PAYROLL → GL MAPPING
//
// `payroll_account_mapping` resolves the semantic buckets a pay run posts
// into (wages, employer taxes, cash, each withholding payable) to concrete
// accounts. It had a reader — gl-posting-service.ts — and NO WRITER anywhere
// in the repository, so the first pay run of any entity died with
// "Missing payroll_account_mapping for bucket: wages_expense".
//
// Crea las cuentas que el catálogo de la entidad no tenga, en vez de mapear un
// bucket a algo parecido: llevar «IMSS por pagar» a la genérica «Retenciones
// por Pagar» deja una cuenta que no concilia contra nada y un pago al IDSE
// imposible de amarrar.
//
// LOS CÓDIGOS DE ESTE ARCHIVO CONVIVEN CON LOS DE OTRAS TRES SEMILLAS
// —chart-seed.ts, account-roles-seed.ts y database/seed.ts— dentro de la MISMA
// entidad, y la guarda de creación es por código. Elegir un número que otra
// semilla ya usa no falla: se salta la creación y hereda la cuenta ajena. Ver
// el comentario de MX_PAYROLL_ACCOUNTS.
//
// Idempotent by construction: it creates only missing accounts and maps only
// unmapped buckets, so re-running never overwrites a firm's own choice.
// ============================================================

export interface PayrollAccountSpec {
  code: string;
  name: string;
  account_type: 'asset' | 'liability' | 'expense';
  normal_balance: 'debit' | 'credit';
  fs_category: string;
  description: string;
}

/** Buckets `gl-posting-service` resolves. The first three are mandatory there. */
export const REQUIRED_BUCKETS = ['wages_expense', 'payroll_tax_expense', 'cash_payroll'] as const;

/**
 * México. LOS CÓDIGOS NO PUEDEN CHOCAR CON LOS DE OTRA SEMILLA.
 *
 * Este catálogo pedía 5200, 5210, 2150, 2160, 2170 y 2180. Los cinco últimos
 * y el primero ya los declaraba otra semilla que corre ANTES —el catálogo
 * base (chart-seed.ts) y los roles del CFDI (account-roles-seed.ts)—, y la
 * guarda de más abajo es por CÓDIGO: `if (byCode.has(spec.code)) continue`.
 * Así que la cuenta no se creaba y el bucket terminaba apuntando a la cuenta
 * ajena que ocupaba ese número. No tronaba: la colisión era de significado.
 *
 * El resultado en toda entidad mexicana recién creada:
 *   wages_expense       → 5200 «Devoluciones y Descuentos sobre Compras»
 *   imss_payable        → 2150 «Anticipos de Clientes»
 *   infonavit_payable   → 2160 «Sueldos por Pagar»
 *   garnishment_payable → 2170 «IMSS por Pagar»
 *   benefits_payable    → 2180 «IEPS por Pagar»
 * Es decir: el sueldo bruto cargado a un contra-costo de naturaleza acreedora,
 * y tres pasivos de nómina revueltos con anticipos de clientes y con IEPS.
 *
 * POR QUÉ SE MUEVE ÉSTE Y NO EL OTRO. Lo decide el agrupador del SAT (Anexo
 * 24), que es con lo que esta contabilidad se presenta:
 *   · 503 «Devoluciones, descuentos o bonificaciones sobre compras» vive en la
 *     familia 5xx de COSTOS. La cuenta 5200 de account-roles-seed está bien
 *     donde está: es un contra-costo y su número lo refleja.
 *   · 601.01 «Sueldos y salarios», 601.26 «Cuotas al IMSS» y 601.27
 *     «Aportaciones al INFONAVIT» viven todos bajo 601 «Gastos generales».
 *     La nómina es GASTO DE OPERACIÓN, o sea 6xxx en esta numeración, y nunca
 *     debió pedir un número de la familia de costos.
 *   · 211 «Provisión de contribuciones de seguridad social por pagar» cubre a
 *     la vez IMSS e INFONAVIT: por eso quedan contiguos, 2170 y 2175.
 *
 * DOS CÓDIGOS SE REUSAN EN LUGAR DE DUPLICARSE:
 *   · 6110 «Sueldos y Salarios» ya existe en BASE_CHART_MX, y ROLE_MAP ya
 *     manda ahí el rol `sueldos_gasto`. Pedir un número propio partía el gasto
 *     de nómina en dos cuentas según entrara por CFDI o por corrida de nómina.
 *     Se declara aquí ADEMÁS, con el nombre idéntico, porque el catálogo base
 *     es condicional (sólo corre si la entidad no tenía cuentas) y
 *     wages_expense es un bucket obligatorio: sobre catálogo importado tiene
 *     que existir igual. Es el mismo motivo por el que account-roles-seed
 *     repite 1130 y 2120.
 *   · 2170 «IMSS por Pagar» ya lo crea account-roles-seed, que corre siempre y
 *     sin condición. Duplicarlo bajo otro número dejaba dos cuentas de IMSS
 *     que nadie podría conciliar contra un solo pago al SUA.
 */
export const MX_PAYROLL_ACCOUNTS: PayrollAccountSpec[] = [
  {
    code: '2165', name: 'Otras Retenciones de Nómina', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Pensiones alimenticias, préstamos y descuentos posteriores al impuesto.',
  },
  {
    code: '2175', name: 'INFONAVIT por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Aportaciones y amortizaciones de crédito, bimestrales.',
  },
  {
    code: '2185', name: 'Prestaciones por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Deducciones anteriores al impuesto retenidas a favor de un tercero.',
  },
  {
    // El nombre tiene que ser CARÁCTER POR CARÁCTER el de BASE_CHART_MX: dos
    // semillas que declaran el mismo código con nombres distintos es justo la
    // falla que este catálogo acaba de corregir, y hay un criterio del plan
    // que la persigue.
    code: '6110', name: 'Sueldos y Salarios', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Percepciones brutas del personal, antes de retenciones.',
  },
  {
    code: '6115', name: 'Cuotas Patronales IMSS e INFONAVIT', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description:
      'Aportaciones que paga el patrón, separadas del sueldo porque no son percepción ' +
      'del trabajador y no entran en su CFDI de nómina.',
  },
  {
    // F08a. Existe sólo para los despachos que contestan
    // `subsidio_al_empleo_entregado_registro` = gasto_del_patron: el subsidio
    // que se entregó en efectivo y que se decide NO acreditar. Con el criterio
    // por omisión —cuenta por cobrar al fisco— esta cuenta nunca se toca, y por
    // eso no es un bucket obligatorio: la corrida sólo la pide cuando el
    // despacho eligió absorberlo.
    code: '6118', name: 'Subsidio al Empleo Absorbido', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description:
      'Subsidio al empleo entregado en efectivo al trabajador que el patrón decide no ' +
      'acreditar contra el ISR retenido a otros.',
  },
];

export const MX_BUCKET_MAP: Record<string, string> = {
  wages_expense: '6110',
  payroll_tax_expense: '6115',
  cash_payroll: '1111',        // Banco Nacional - MXN, del catálogo base
  isr_payable: '2130',         // ISR por Pagar, del catálogo base
  imss_payable: '2170',        // IMSS por Pagar, de account-roles-seed
  infonavit_payable: '2175',
  garnishment_payable: '2165',
  benefits_payable: '2185',
  subsidio_empleo_expense: '6118',
};

/**
 * Estados Unidos. MISMA COLISIÓN, MISMA CAUSA.
 *
 * `ensureEntityAccounting` siembra el catálogo base MEXICANO y los roles del
 * CFDI en TODA entidad, sin mirar el país, y sólo después ramifica por país
 * para la nómina. Así que este catálogo convive con los otros dos igual que el
 * mexicano, y chocaba en los mismos números: 5200, 2150, 2170, 2180 y 1111.
 * Una entidad estadounidense cargaba también su sueldo bruto a «Devoluciones y
 * Descuentos sobre Compras».
 *
 * Que el catálogo base sea el mexicano para una entidad de EE. UU. es OTRO
 * defecto, y no se arregla aquí. Lo que sí se hace es no depender de él:
 *   · Los gastos se van a 6150/6155, en la banda de gastos de operación, por
 *     el mismo motivo contable que la nómina mexicana —son gasto, no costo—.
 *   · Los pasivos se agrupan en 2151–2157, el único tramo que ninguna otra
 *     semilla toca. El paso de uno en uno no es capricho: 2151–2154 ya estaban
 *     así, y seguir la convención del propio bloque vale más que imponerle la
 *     de x5 del catálogo mexicano.
 *   · el banco deja de declararse. Se REUSA, exactamente como MX reusa 1111 y
 *     2130: declararlo como «Operating Bank Account» chocaba con «Banco
 *     Nacional - MXN». Y desde que el catálogo base ramifica por país, una
 *     entidad estadounidense ya no recibe 1111 —que es una cuenta en pesos—
 *     sino 1115 «Cuenta Bancaria Operativa», del estrato fiscal neutro. Si la
 *     entidad llegó con catálogo propio y no tiene ninguna de las dos,
 *     cash_payroll sale en `bucketsUnmappable`, que es la conducta diseñada
 *     para eso y la que MX ya tenía.
 */
export const US_PAYROLL_ACCOUNTS: PayrollAccountSpec[] = [
  {
    code: '2151', name: 'FICA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Social Security and Medicare, employee and employer halves.',
  },
  {
    code: '2152', name: 'FUTA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Federal unemployment tax.',
  },
  {
    code: '2153', name: 'SUTA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'State unemployment tax.',
  },
  {
    code: '2154', name: 'State and Local Tax Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'State income tax and disability withholding.',
  },
  {
    code: '2155', name: 'Federal Income Tax Withheld', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'FIT withheld from employees, until deposited.',
  },
  {
    code: '2156', name: 'Garnishments Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Post-tax deductions owed to a third party.',
  },
  {
    code: '2157', name: 'Benefits Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Pre-tax deductions owed to a benefits provider.',
  },
  {
    code: '6150', name: 'Salaries and Wages', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Gross compensation before withholding.',
  },
  {
    code: '6155', name: 'Employer Payroll Taxes', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Employer FICA, FUTA and SUTA — the employer cost, not the employee withholding.',
  },
];

export const US_BUCKET_MAP: Record<string, string> = {
  wages_expense: '6150',
  payroll_tax_expense: '6155',
  cash_payroll: '1115',        // Cuenta Bancaria Operativa, del estrato neutro
  fit_payable: '2155',
  fica_payable: '2151',
  futa_payable: '2152',
  suta_payable: '2153',
  state_tax_payable: '2154',
  garnishment_payable: '2156',
  benefits_payable: '2157',
};

/** Los dos carriles de nómina que existen. 'USA' es la clave de COUNTRY_PROFILES. */
export type PaisNomina = 'MX' | 'USA';

export interface PayrollSeedResult {
  /**
   * El país que ESTA corrida usó para escoger el catálogo, no el que llegó por
   * parámetro. Se declaraba con un `country === 'USA' ? 'USA' : 'MX'` propio,
   * paralelo al de `chartFor`, y lo que llega de la base es el alfa-2 'US'
   * (legal_entities.incorporation_country es CHAR(2)): una entidad
   * estadounidense recibía el catálogo estadounidense correcto y se declaraba
   * mexicana. Y salía al mundo, porque `entity create --json` vuelca el
   * resultado entero. Ahora lo produce `chartFor`, de una sola normalización,
   * para que catálogo y etiqueta no puedan volver a separarse.
   */
  country: PaisNomina;
  accountsCreated: string[];
  bucketsMapped: string[];
  /** Buckets already mapped by someone else; left exactly as they were. */
  bucketsAlreadyMapped: string[];
  /**
   * Buckets whose account this seeder does not create and the chart does not
   * have — the onboarded-chart case. The firm has to choose the account.
   */
  bucketsUnmappable: Array<{ bucket: string; code: string }>;
}

/**
 * Acepta 'US' y 'USA'. La columna incorporation_country es CHAR(2), así que lo
 * que la base puede guardar es 'US' — y `chartFor` comparaba contra 'USA', de
 * modo que jamás devolvía el catálogo estadounidense por más que la entidad lo
 * fuera. Se aceptan los dos: el alfa-2 que se almacena y la clave 'USA' con la
 * que el asistente y COUNTRY_PROFILES nombran al país.
 *
 * Cualquier otro país sigue siendo México, que es la regla de la casa ante la
 * duda (ver pais-contable.ts).
 *
 * ES FUNCIÓN Y NO UNA LÍNEA SUELTA porque la comparación estaba escrita DOS
 * VECES —aquí y en el `country:` del resultado— y las dos copias divergieron:
 * una aceptaba 'US' y la otra no, así que la entidad estadounidense se
 * llevaba el catálogo correcto y la etiqueta equivocada. Una sola normaliza.
 */
export function normalizarPais(country: string | null | undefined): PaisNomina {
  const pais = (country ?? '').trim().toUpperCase();
  return pais === 'US' || pais === 'USA' ? 'USA' : 'MX';
}

/**
 * El catálogo de nómina del país, junto con el país ya normalizado que lo
 * eligió: quien informe cuál se usó lee `pais` de aquí en vez de rehacer la
 * comparación por su cuenta.
 */
export function chartFor(country: string): {
  pais: PaisNomina;
  accounts: PayrollAccountSpec[];
  buckets: Record<string, string>;
} {
  const pais = normalizarPais(country);
  return pais === 'USA'
    ? { pais, accounts: US_PAYROLL_ACCOUNTS, buckets: US_BUCKET_MAP }
    : { pais, accounts: MX_PAYROLL_ACCOUNTS, buckets: MX_BUCKET_MAP };
}

/**
 * Creates the payroll accounts an entity's chart lacks and maps every bucket
 * that has no mapping yet.
 *
 * `options.client` lets entity creation seed the chart, the roles and this
 * mapping inside one transaction, so an entity is never half-configured.
 */
export async function seedPayrollAccountMapping(
  entityId: string,
  tenantId: string,
  country: string,
  createdBy: string,
  options?: { client?: pg.PoolClient }
): Promise<PayrollSeedResult> {
  const run = async (client: pg.PoolClient): Promise<PayrollSeedResult> => {
    const { pais, accounts, buckets } = chartFor(country);

    const existing = await client.query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const byCode = new Map(existing.rows.map((r) => [r.code, r.id]));
    const accountsCreated: string[] = [];

    for (const spec of accounts) {
      if (byCode.has(spec.code)) continue;
      const id = uuidv4();
      await client.query(
        `INSERT INTO accounts (
           id, code, name, account_type, normal_balance, fs_category,
           description, entity_id, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id, spec.code, spec.name, spec.account_type, spec.normal_balance,
          spec.fs_category, spec.description, entityId, createdBy,
        ]
      );
      byCode.set(spec.code, id);
      accountsCreated.push(spec.code);
    }

    const mapped = await client.query<{ bucket: string }>(
      'SELECT bucket FROM payroll_account_mapping WHERE entity_id = $1',
      [entityId]
    );
    const already = new Set(mapped.rows.map((r) => r.bucket));

    const bucketsMapped: string[] = [];
    const bucketsAlreadyMapped: string[] = [];
    const bucketsUnmappable: Array<{ bucket: string; code: string }> = [];
    for (const [bucket, code] of Object.entries(buckets)) {
      if (already.has(bucket)) {
        bucketsAlreadyMapped.push(bucket);
        continue;
      }
      const accountId = byCode.get(code);
      if (!accountId) {
        // Two codes are REUSED from the base chart rather than seeded here
        // (MX: 1111 the bank, 2130 ISR por pagar). An entity onboarded from
        // another system keeps its own chart — that is what the 'auto'
        // strategy is for — so those codes may simply not exist.
        //
        // Refusing to seed anything in that case would block the whole
        // mapping over one account the firm must choose for itself anyway;
        // inventing a bank account would be worse. So: map everything that
        // can be mapped, and report the rest. `doctor` surfaces it, and the
        // posting engine still fails loudly if a required bucket is used
        // before someone picks an account.
        bucketsUnmappable.push({ bucket, code });
        continue;
      }
      await client.query(
        `INSERT INTO payroll_account_mapping (id, tenant_id, entity_id, bucket, account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, entity_id, bucket) DO NOTHING`,
        [uuidv4(), tenantId, entityId, bucket, accountId]
      );
      bucketsMapped.push(bucket);
    }

    return {
      // El país sale de `chartFor`, que es quien escogió el catálogo. Antes se
      // recalculaba aquí con otra comparación y las dos discrepaban en 'US'.
      country: pais,
      accountsCreated,
      bucketsMapped,
      bucketsAlreadyMapped,
      bucketsUnmappable,
    };
  };

  return options?.client ? run(options.client) : withTransaction(run);
}
