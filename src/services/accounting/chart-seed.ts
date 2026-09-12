import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * Catálogo de cuentas base para una entidad mexicana.
 *
 * Vivía embebido en src/database/seed.ts, donde solo lo alcanzaba `npm run
 * seed`. Se extrajo aquí porque `mnemosine init` NUNCA creaba catálogo: una
 * entidad recién creada no tenía ninguna de las cuentas que ROLE_MAP espera,
 * así que sembrar los roles a secas dejaba trece sin mapear —incluidos cxc,
 * cxp, banco, ingreso, gasto e IVA—, que son justo los que necesitan
 * postInvoiceEntry y postBillEntry.
 *
 * Las 38 filas están transcritas SIN cambios de código ni de nombre.
 */
export interface ChartAccountSpec {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
      | 'contra_asset' | 'contra_liability' | 'contra_equity';
  sub: string | null;
  fs: string;
  balance: 'debit' | 'credit';
  parent?: string;
  header?: boolean;
  system?: boolean;
}

// ── El catálogo, en tres estratos ────────────────────────────
//
// Vivía como una sola lista de 38 renglones llamada BASE_CHART_MX, y ese
// nombre escondía que sólo SEIS de sus cuentas son mexicanas. Las otras 32 son
// partida doble: activo, pasivo, capital, ingresos, costos y gastos, con los
// nombres en español porque el producto se usa en español, no porque el país
// las determine.
//
// Importaba porque `ensureEntityAccounting` sembraba la lista entera en TODA
// entidad sin mirar el país: una sociedad estadounidense nacía con «IVA
// Acreditable», «IVA Trasladado», «ISR por Pagar» y una cuenta de banco
// denominada en pesos. No estorbaban en silencio: son renglones del balance
// que se presentan, y el catálogo es lo primero que un contador revisa.

/** Partida doble. Lo que necesita cualquier entidad, sea del país que sea. */
export const CATALOGO_UNIVERSAL: ChartAccountSpec[] = [
    // Assets
    { code: '1000', name: 'Activo', type: 'asset', sub: null, fs: 'current_assets', balance: 'debit', header: true },
    { code: '1100', name: 'Activo Circulante', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1110', name: 'Caja y Bancos', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1120', name: 'Cuentas por Cobrar', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1140', name: 'Inventarios', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1200', name: 'Activo Fijo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1210', name: 'Mobiliario y Equipo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1220', name: 'Equipo de Cómputo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1230', name: 'Equipo de Transporte', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1290', name: 'Depreciación Acumulada', type: 'contra_asset', sub: null, fs: 'non_current_assets', balance: 'credit', parent: '1200' },
    // ── LO QUE SE DEBE Y TODAVÍA NO SE PAGA (D1) ────────────────────
    //
    // De los 61 nombres que este catálogo sembraba no había UNA sola
    // estimación, provisión ni cuenta diferida. Sin ellas no hay devengo
    // posible: un despacho que no puede provisionar publica once meses de
    // utilidad inflada y un diciembre catastrófico, y ninguno de los doce
    // estados es firmable.
    //
    // CUELGAN DEL CIRCULANTE, NO DE LA CUENTA QUE CORRIGEN, y no es un
    // descuido: en el catálogo del SAT la «Estimación de cuentas incobrables»
    // (108) y la «Estimación de inventarios obsoletos» (116) son cuentas de
    // NIVEL 1 por derecho propio, no subcuentas del activo que ajustan.
    // Colgarlas de 1120 y 1140 —que es donde la intuición contable las pone—
    // las volvía hijas de una cuenta que el Anexo 24 puede omitir, y una hija
    // cuyo padre no viaja en el archivo sale HUÉRFANA y bloquea la entrega
    // entera (regla CAT-HUERFANA). Lo destapó f07b-ataque.
    //
    // Las estimaciones son CONTRA-ACTIVO y no gasto acumulado: reducen el
    // activo que corrigen y se presentan restando en su mismo renglón, que
    // es lo que la NIF C-3 pide para el deterioro de cuentas por cobrar.
    { code: '1129', name: 'Estimación para Cuentas de Cobro Dudoso', type: 'contra_asset', sub: null, fs: 'current_assets', balance: 'credit', parent: '1100' },
    { code: '1149', name: 'Estimación de Inventarios Obsoletos', type: 'contra_asset', sub: null, fs: 'current_assets', balance: 'credit', parent: '1100' },
    { code: '1300', name: 'Activo Diferido', type: 'asset', sub: null, fs: 'non_current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1310', name: 'Impuestos Diferidos a Favor', type: 'asset', sub: null, fs: 'non_current_assets', balance: 'debit', parent: '1300' },
    // Liabilities
    { code: '2000', name: 'Pasivo', type: 'liability', sub: null, fs: 'current_liabilities', balance: 'credit', header: true },
    { code: '2100', name: 'Pasivo Circulante', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', header: true, parent: '2000' },
    { code: '2110', name: 'Cuentas por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    // 2201-2205 Y NO 2195-2205: la 2199 la usa un escenario de
    // tests/integration/f07b-ataque. El catálogo sembrado comparte espacio de
    // nombres con las cuentas que las pruebas crean a mano, así que un código
    // libre lo es sólo si lo es en `src/` Y en `tests/`. Dos semillas —o una
    // semilla y una prueba— que reclaman el mismo código corrompen en silencio.
    //
    // La provisión es un pasivo, no una reserva de capital: es dinero que ya
    // se debe aunque todavía no se pague. El encabezado es universal porque
    // toda jurisdicción devenga beneficios a empleados; los conceptos
    // concretos —aguinaldo, PTU— son de la LFT y viven en el estrato MX.
    { code: '2201', name: 'Provisiones de Beneficios a Empleados', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', header: true, parent: '2100' },
    { code: '2300', name: 'Impuestos Diferidos por Pagar', type: 'liability', sub: 'long_term_liability', fs: 'long_term_liabilities', balance: 'credit', parent: '2000' },
    // Equity
    { code: '3000', name: 'Capital Contable', type: 'equity', sub: null, fs: 'equity', balance: 'credit', header: true },
    { code: '3100', name: 'Capital Social', type: 'equity', sub: 'common_stock', fs: 'equity', balance: 'credit', parent: '3000', system: true },
    { code: '3200', name: 'Resultado de Ejercicios Anteriores', type: 'equity', sub: 'retained_earnings', fs: 'equity', balance: 'credit', parent: '3000', system: true },
    { code: '3300', name: 'Resultado del Ejercicio', type: 'equity', sub: 'retained_earnings', fs: 'equity', balance: 'credit', parent: '3000' },
    // 3600 Y NO 3400: la 3400 la usa un escenario de acciones propias en
    // tests/integration/g1b-ataque, y el catálogo sembrado comparte espacio de
    // nombres con lo que las pruebas crean a mano. Buscar códigos libres sólo
    // en `src/` deja fuera la mitad del espacio: hay que mirar `tests/` también.
    //
    // El ORI es capital que NO pasó por el resultado del ejercicio (NIF B-3):
    // revaluación, conversión de operaciones extranjeras y remediciones de
    // beneficios a empleados. Su `fs` propio —que la 078 añade al CHECK— es
    // lo que impide que una revaluación se lea como aportación de socios.
    { code: '3600', name: 'Otros Resultados Integrales', type: 'equity', sub: null, fs: 'ori', balance: 'credit', parent: '3000' },
    { code: '3900', name: 'Resumen de Ingresos y Gastos', type: 'equity', sub: null, fs: 'equity', balance: 'credit', parent: '3000', system: true },
    // Revenue
    { code: '4000', name: 'Ingresos', type: 'revenue', sub: null, fs: 'revenue', balance: 'credit', header: true },
    { code: '4100', name: 'Ventas', type: 'revenue', sub: 'operating_revenue', fs: 'revenue', balance: 'credit', parent: '4000' },
    { code: '4200', name: 'Ingresos por Servicios', type: 'revenue', sub: 'operating_revenue', fs: 'revenue', balance: 'credit', parent: '4000' },
    { code: '4300', name: 'Otros Ingresos', type: 'revenue', sub: 'other_revenue', fs: 'other_income', balance: 'credit', parent: '4000' },
    // Expenses
    { code: '5000', name: 'Costos y Gastos', type: 'expense', sub: null, fs: 'operating_expenses', balance: 'debit', header: true },
    { code: '5100', name: 'Costo de Ventas', type: 'expense', sub: 'cost_of_goods', fs: 'cogs', balance: 'debit', parent: '5000' },
    { code: '6000', name: 'Gastos de Operación', type: 'expense', sub: null, fs: 'operating_expenses', balance: 'debit', header: true },
    { code: '6100', name: 'Gastos de Administración', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6000' },
    { code: '6110', name: 'Sueldos y Salarios', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6120', name: 'Renta de Oficina', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6130', name: 'Servicios Públicos', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6140', name: 'Depreciación', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6200', name: 'Gastos de Venta', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6000' },
    { code: '6300', name: 'Gastos Financieros', type: 'expense', sub: 'other_expense', fs: 'other_expenses', balance: 'debit', parent: '6000' },
];

/**
 * Lo que sólo tiene sentido en una contabilidad mexicana.
 *
 * Las dos cuentas de banco están aquí y no en el estrato universal porque
 * llevan la moneda en el nombre: «Banco Nacional - MXN» en el catálogo de una
 * sociedad de Delaware es un renglón que nadie va a usar y que además miente
 * sobre la moneda funcional de la entidad.
 */
export const ESTRATO_FISCAL_MX: ChartAccountSpec[] = [
    // ── LO QUE LA LEY MEXICANA HACE DEBER MES A MES (D1) ────────────
    //
    // Cuatro conceptos que se DEVENGAN durante el año y se pagan en una sola
    // fecha, o en ninguna hasta que el trabajador se va. Sin estas cuentas el
    // devengo no tiene dónde escribirse:
    //
    //   · Aguinaldo — LFT 87: al menos 15 días, pagaderos antes del 20 de
    //     diciembre. Se gana día a día durante todo el año.
    //   · Vacaciones — LFT 76 (reformado 2023): 12 días desde el primer año,
    //     subiendo con la antigüedad. El derecho nace al cumplir año.
    //   · Prima vacacional — LFT 80: 25 % de los días de vacaciones.
    //   · PTU — LFT 117-131 y CPEUM 123-A-IX: 10 % de la renta gravable, a
    //     repartir dentro de los 60 días siguientes a la declaración anual.
    //
    // La prima de antigüedad (LFT 162) NO tiene cuenta aquí y es deliberado:
    // es un beneficio por terminación de largo plazo que la NIF D-3 manda
    // valuar ACTUARIALMENTE —hipótesis de rotación, mortalidad y descuento—,
    // y una cuenta sin motor que la alimente es peor que no tenerla: parece
    // que el sistema la cubre. Entra cuando entre la valuación, no antes.
    { code: '2202', name: 'Provisión de Aguinaldo', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2201' },
    { code: '2203', name: 'Provisión de Vacaciones', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2201' },
    { code: '2204', name: 'Provisión de Prima Vacacional', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2201' },
    { code: '2205', name: 'Provisión de PTU', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2201' },
    // Y LA CONTRAPARTIDA DEL CARGO, que faltaba: las cuatro provisiones de
    // arriba son el ABONO de un asiento cuyo cargo no tenía dónde ir.
    //
    // NO SE CARGA A 6110 «Sueldos y Salarios», y el motivo es el mismo por el
    // que 6115 sacó de ahí las cuotas patronales: la 6110 se concilia contra
    // los CFDI de nómina timbrados, y una provisión es precisamente lo que
    // todavía no se pagó ni se timbró. Fundirlas rompe el único amarre que un
    // despacho tiene entre su gasto de nómina y lo que declaró al SAT.
    //
    // Una sola cuenta de gasto para los tres conceptos, y no tres: el desglose
    // que un auditor necesita está en el lado del PASIVO —2202, 2203 y 2204 se
    // extinguen con hechos distintos y se concilian por separado—, mientras que
    // en el estado de resultados los tres son la misma línea: costo laboral
    // devengado. Tres renglones de gasto que siempre se mueven juntos no
    // informan de nada y sí obligan a mantener tres mapeos.
    { code: '6116', name: 'Provisión de Prestaciones al Personal', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    // LGSM 20: 5 % de las utilidades a la reserva legal hasta que alcance el
    // 20 % del capital social. Es capital, no pasivo, y es obligación de la
    // sociedad mexicana, no de toda entidad: por eso vive en el estrato.
    { code: '3150', name: 'Reserva Legal', type: 'equity', sub: null, fs: 'equity', balance: 'credit', parent: '3000' },
    { code: '1111', name: 'Banco Nacional - MXN', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1112', name: 'Banco Nacional - USD', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1130', name: 'IVA Acreditable', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '2120', name: 'IVA Trasladado', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2130', name: 'ISR por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2140', name: 'Retenciones por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
];

/**
 * El mínimo fiscal de una entidad NO mexicana.
 *
 * No es un plan de cuentas estadounidense: el plan de cierre declara el carril
 * de EE. UU. «deliberadamente somero», y un catálogo US GAAP completo es
 * justamente lo que corta del alcance. Son las tres cuentas sin las cuales el
 * motor que YA existe no puede postear:
 *
 *   · el banco, porque el rol `banco` y el bucket `cash_payroll` lo exigen;
 *   · las dos de impuesto, porque postInvoiceEntry y postBillEntry piden los
 *     roles iva_trasladado / iva_acreditable en cuanto `tax_amount > 0`
 *     (ar-ap-posting.ts). Una factura estadounidense CON impuesto sobre ventas
 *     reventaría con MISSING_ROLE_ACCOUNT si no hubiera dónde ponerlo.
 *
 * Los nombres son genéricos a propósito: «Impuesto sobre Ventas» sirve para el
 * sales tax estadounidense y para cualquier otro impuesto trasladado, y no
 * promete un tratamiento fiscal que este motor no implementa.
 *
 * Códigos propios y no los mexicanos: dos semillas no pueden declarar el mismo
 * código con nombres distintos (criterio E1.1), y además reusar 1130 para algo
 * que no es IVA acreditable haría ilegible el catálogo de las dos.
 */
export const ESTRATO_FISCAL_NEUTRO: ChartAccountSpec[] = [
    { code: '1115', name: 'Cuenta Bancaria Operativa', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1136', name: 'Impuesto Acreditable sobre Compras', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '2135', name: 'Impuesto sobre Ventas por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
];

/**
 * El catálogo mexicano completo, que es lo que este nombre significó siempre.
 * Se conserva porque hay código y pruebas que lo nombran, y porque una entidad
 * mexicana tiene que recibir EXACTAMENTE lo mismo que antes de partir la lista.
 *
 * El orden importa: `ensureBaseChart` resuelve parent_id leyendo lo que ya
 * insertó, así que el padre tiene que preceder al hijo. Todos los padres viven
 * en el estrato universal, de modo que concatenarlo primero lo garantiza.
 */
export const BASE_CHART_MX: ChartAccountSpec[] = [...CATALOGO_UNIVERSAL, ...ESTRATO_FISCAL_MX];

/** El catálogo que le toca a una entidad según lleve o no libros mexicanos. */
export function catalogoBasePara(esMexicana: boolean): ChartAccountSpec[] {
  return esMexicana
    ? BASE_CHART_MX
    : [...CATALOGO_UNIVERSAL, ...ESTRATO_FISCAL_NEUTRO];
}

/**
 * Crea las cuentas del catálogo base que falten en la entidad. Idempotente:
 * ON CONFLICT (code, entity_id) DO NOTHING y devuelve solo los códigos que
 * realmente creó. El arreglo está ordenado topológicamente (el padre siempre
 * precede al hijo), así que parent_id se resuelve leyendo lo ya insertado.
 *
 * `esMexicana` decide QUÉ catálogo se siembra, no si se siembra: una entidad
 * no mexicana recibe el mismo andamiaje de partida doble y, en lugar del
 * estrato fiscal mexicano, el neutro. Por omisión true, que es la regla de la
 * casa ante la duda (ver services/jurisdiction/jurisdiction.ts) y deja intacto a todo llamador que
 * no se entere de este parámetro.
 *
 * No abre transacción propia: trabaja sobre el cliente que recibe.
 */
export async function ensureBaseChart(
  client: pg.PoolClient,
  entityId: string,
  createdBy: string,
  esMexicana = true
): Promise<string[]> {
  const existentes = await client.query<{ code: string; id: string }>(
    'SELECT code, id FROM accounts WHERE entity_id = $1',
    [entityId]
  );
  const porCodigo = new Map(existentes.rows.map((r) => [r.code, r.id]));
  const creadas: string[] = [];

  for (const c of catalogoBasePara(esMexicana)) {
    if (porCodigo.has(c.code)) continue;
    const parentId = c.parent ? porCodigo.get(c.parent) ?? null : null;
    const id = uuidv4();
    const res = await client.query<{ id: string }>(
      `INSERT INTO accounts (id, code, name, account_type, account_subtype, fs_category,
        normal_balance, entity_id, parent_id, is_header, is_system_account,
        allow_manual_entries, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (code, entity_id) DO NOTHING
       RETURNING id`,
      [id, c.code, c.name, c.type, c.sub ?? null, c.fs, c.balance, entityId, parentId,
       c.header ?? false, c.system ?? false, !(c.header ?? false), createdBy]
    );
    // Si otra transacción ganó la carrera, el RETURNING viene vacío: releer.
    const idReal = res.rows[0]?.id
      ?? (await client.query<{ id: string }>(
            'SELECT id FROM accounts WHERE code = $1 AND entity_id = $2', [c.code, entityId]
         )).rows[0]?.id;
    if (idReal) {
      porCodigo.set(c.code, idReal);
      if (res.rows[0]?.id) creadas.push(c.code);
    }
  }
  return creadas;
}
