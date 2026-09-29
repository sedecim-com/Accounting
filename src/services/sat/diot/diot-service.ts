import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../../database/connection.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { entityUsesCashBasisIva } from '../../accounting/iva-cash-basis.js';
import { getPolicy } from '../../policy/policy-service.js';
import {
  desglosarDocumento,
  desgloseCero,
  ivaDelDesglose,
  sumarDesgloses,
  DECIMALES_DIOT,
  type PoliticaBaseExenta,
} from './desglose.js';
import { hechosDelMes, rangoDelMes, type HechoPagado } from './hechos.js';
import { bloquean, type Hallazgo } from './hallazgos.js';
import { normalizarRfc } from './rfc.js';
import { resolverTercero, type PoliticasDelTercero, type TerceroCrudo } from './tercero.js';
import type {
  DiotConstruida,
  DocumentoDelRenglon,
  PoliticaAplicada,
  RenglonDiot,
  TotalesDiot,
} from './modelo.js';

// ============================================================
// F07c · LA DIOT, ARMADA
//
// Junta las cuatro piezas: el hecho (hechos.ts, que es el mayor), el desglose
// por tasa (desglose.ts, que es aritmética), el tercero (tercero.ts, que es
// el catálogo) y las tres políticas del panel.
//
// LAS TRES POLÍTICAS SE LEEN AQUÍ, CON SU CLAVE LITERAL, y cada una cambia el
// resultado de verdad:
//   · diot_tipo_operacion_por_omision → con qué tipo se declara un proveedor
//     que no lo tiene capturado, o si no se declara la DIOT.
//   · diot_tercero_sin_rfc            → si el proveedor sin RFC usable
//     bloquea la declaración o viaja como tercero global (15).
//   · diot_iva_exento_y_base          → si un renglón exento sin base
//     bloquea, se deriva del subtotal o se omite.
//   · diot_default_operation_type_foreign → the same, for a foreign supplier
//     (05), whose catalogue (§3.1: 02, 03, 07) excludes the national 85.
//   · diot_creditable_iva_proportion → whether the SAT batch file may declare
//     all IVA paid as tied exclusively to taxed activities (applied in
//     sat-batch.ts). Its default is refused here when the ledger shows exempt
//     revenue in the fiscal year (proportionFindings).
//
// ARMAR NO SE NIEGA; ENTREGAR SÍ. `construirDiot` termina siempre y devuelve
// todos los hallazgos, porque las dos políticas que se niegan prometen
// nombrar a los proveedores EN PLURAL: lanzar al primero obligaría a una
// vuelta por proveedor. El que se planta es el serializador, que mira
// `bloquean()`.
// ============================================================

/** SAT código agrupador for exempt sales: 401.07 and its cash and credit children. */
export const EXEMPT_REVENUE_GROUPING_CODES: readonly string[] = ['401.07', '401.08', '401.09'];

/**
 * What `diot_creditable_iva_proportion` says about this DIOT.
 *
 * `taxed_only` declares every peso of IVA as tied exclusively to taxed
 * activities. That is only true for an entity with no exempt activity, so
 * exempt revenue in the fiscal year (up to the DIOT month) blocks it, whether
 * the value was answered or not. Left unanswered, it travels as a notice on
 * every DIOT, so the default is never applied in silence.
 */
export function proportionFindings(
  policy: { value: string; defined: boolean },
  exemptRevenue: string
): Hallazgo[] {
  if (policy.value !== 'taxed_only') return [];
  const findings: Hallazgo[] = [];
  if (new Decimal(exemptRevenue).greaterThan(0)) {
    findings.push({
      codigo: 'DIOT-EXEMPT-REVENUE-WITHOUT-PROPORTION',
      severidad: 'bloqueante',
      politica: 'diot_creditable_iva_proportion',
      mensaje:
        `El mayor registra ${exemptRevenue} de ingresos exentos en el ejercicio (cuentas con ` +
        `agrupador ${EXEMPT_REVENUE_GROUPING_CODES.join(', ')}), y la política ` +
        `diot_creditable_iva_proportion declara todo el IVA como de actividades exclusivamente ` +
        `gravadas. Con actividades exentas el IVA acreditable sigue la proporción del art. 5 ` +
        `frac. V LIVA: contesta la política con "block" y reparte el IVA en el portal.`,
    });
  }
  if (!policy.defined) {
    findings.push({
      codigo: 'DIOT-PROPORTION-BY-DEFAULT',
      severidad: 'aviso',
      politica: 'diot_creditable_iva_proportion',
      mensaje:
        `Todo el IVA acreditable se declara como de actividades exclusivamente gravadas porque ` +
        `la política diot_creditable_iva_proportion no está contestada. Confírmala si la entidad ` +
        `no tiene actividades exentas.`,
    });
  }
  return findings;
}

/** Exempt revenue (credit − debit) posted from January 1 to the end of the DIOT month. */
async function exemptRevenueOfYear(
  client: pg.PoolClient,
  entityId: string,
  year: number,
  until: string
): Promise<string> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0)::text AS total
       FROM journal_entry_lines jel
       JOIN journal_entries je
         ON je.id = jel.journal_entry_id
        AND je.status = 'posted'
        AND je.entity_id = $1
        AND je.entry_date BETWEEN $2::date AND $3::date
       JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $1
      WHERE a.codigo_agrupador_sat = ANY($4::text[])`,
    [entityId, `${String(year)}-01-01`, until, [...EXEMPT_REVENUE_GROUPING_CODES]]
  );
  return rows[0]?.total ?? '0';
}

export interface OpcionesDiot {
  tenantId: string;
  entityId: string;
  anio: number;
  /** 1–12. */
  mes: number;
  /** Para leer dentro de la transacción del llamador. */
  client?: pg.PoolClient;
}

interface FilaContribuyente {
  tenant_id: string;
  name: string;
  tax_id: string | null;
  tax_id_type: string | null;
  incorporation_country: string | null;
}

/**
 * El contribuyente que declara.
 *
 * ACOTADO POR INQUILINO Y CON EL RFC NORMALIZADO, que son los dos defectos de
 * gravedad 2 que la auditoría de F07b encontró en la función equivalente de
 * la balanza: sin `tenant_id` en el WHERE, y con la RLS inerte, verificar la
 * declaración de una entidad ajena resolvía —y archivaba— datos de otro
 * despacho; y sin normalizar, el mismo RFC guardado con espacios funcionaba
 * por un camino y moría por el otro.
 */
async function contribuyente(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string
): Promise<{ rfc: string; razonSocial: string }> {
  const { rows } = await client.query<FilaContribuyente>(
    `SELECT tenant_id, name, tax_id, tax_id_type, incorporation_country
       FROM legal_entities
      WHERE id = $1 AND tenant_id = $2`,
    [entityId, tenantId]
  );
  const fila = rows[0];
  if (!fila) throw new NotFoundError('Entidad legal', entityId);

  if (!(await entityUsesCashBasisIva(client, entityId))) {
    throw new ValidationError(
      `La entidad ${fila.name} no es mexicana (país ${fila.incorporation_country ?? '—'}). ` +
        `La DIOT es una obligación de la LIVA: no hay declaración informativa de operaciones ` +
        `con terceros que armar para una entidad que no causa IVA.`,
      'entity_id'
    );
  }

  const rfc = normalizarRfc(fila.tax_id);
  if (rfc === '') {
    throw new ValidationError(
      `La entidad ${fila.name} no tiene RFC en el expediente y la DIOT se presenta a nombre de ` +
        `un contribuyente identificado.`,
      'tax_id'
    );
  }
  return { rfc, razonSocial: fila.name };
}

async function terceros(
  client: pg.PoolClient,
  entityId: string,
  vendorIds: readonly string[]
): Promise<Map<string, TerceroCrudo>> {
  const porId = new Map<string, TerceroCrudo>();
  if (vendorIds.length === 0) return porId;
  const { rows } = await client.query<{
    id: string;
    company_name: string;
    tax_id: string | null;
    tax_id_type: string | null;
    tipo_tercero: string | null;
    tipo_operacion: string | null;
    id_fiscal_extranjero: string | null;
    pais_residencia: string | null;
    nacionalidad: string | null;
  }>(
    `SELECT id, company_name, tax_id, tax_id_type, tipo_tercero, tipo_operacion,
            id_fiscal_extranjero, pais_residencia, nacionalidad
       FROM vendors
      WHERE entity_id = $1 AND id = ANY($2::uuid[])`,
    [entityId, [...vendorIds]]
  );
  for (const r of rows) {
    porId.set(r.id, {
      vendorId: r.id,
      nombre: r.company_name,
      taxId: r.tax_id,
      taxIdType: r.tax_id_type,
      tipoTercero: r.tipo_tercero,
      tipoOperacion: r.tipo_operacion,
      idFiscalExtranjero: r.id_fiscal_extranjero,
      paisResidencia: r.pais_residencia,
      nacionalidad: r.nacionalidad,
    });
  }
  return porId;
}

const BASES_EXENTAS: readonly string[] = ['exigir_base', 'derivar_del_subtotal', 'omitir_y_avisar'];

export async function construirDiot(opciones: OpcionesDiot): Promise<DiotConstruida> {
  const { tenantId, entityId, anio, mes } = opciones;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    throw new ValidationError(
      `El mes de la DIOT es ${String(mes)}. La declaración es mensual y no tiene mes 13: la ` +
        `balanza de cierre del Anexo 24 sí, ésta no.`,
      'mes'
    );
  }

  const ejecutar = async (client: pg.PoolClient): Promise<DiotConstruida> => {
    const { rfc, razonSocial } = await contribuyente(client, tenantId, entityId);
    const ctx = { tenantId, entityId };

    // ── LAS TRES POLÍTICAS DEL PANEL ────────────────────────────────────
    const pTipoOperacion = await getPolicy(ctx, 'diot_tipo_operacion_por_omision', client);
    const pSinRfc = await getPolicy(ctx, 'diot_tercero_sin_rfc', client);
    const pBaseExenta = await getPolicy(ctx, 'diot_iva_exento_y_base', client);
    const pForeignOperation = await getPolicy(ctx, 'diot_default_operation_type_foreign', client);
    // Applied by the SAT batch serializer (sat-batch.ts): it decides which
    // creditable-IVA box of the 2025 layout carries the IVA paid.
    const pProportion = await getPolicy(ctx, 'diot_creditable_iva_proportion', client);

    const politicas: PoliticaAplicada[] = [
      pTipoOperacion,
      pSinRfc,
      pBaseExenta,
      pForeignOperation,
      pProportion,
    ].map((p) => ({
      clave: p.key,
      valor: p.value,
      definida: p.defined,
    }));

    const hallazgos: Hallazgo[] = proportionFindings(
      pProportion,
      await exemptRevenueOfYear(client, entityId, anio, rangoDelMes(anio, mes).hasta)
    );

    // Un valor fuera del catálogo de la política se detiene aquí: es más
    // barato que descubrirlo repartido por veinte mensajes de proveedor.
    if (!BASES_EXENTAS.includes(pBaseExenta.value)) {
      hallazgos.push({
        codigo: 'DIOT-POLITICA-FUERA-DE-CATALOGO',
        severidad: 'bloqueante',
        politica: 'diot_iva_exento_y_base',
        mensaje:
          `La política diot_iva_exento_y_base vale "${pBaseExenta.value}", que no es ` +
          `exigir_base, derivar_del_subtotal ni omitir_y_avisar.`,
      });
    }
    const politicaBaseExenta = (
      BASES_EXENTAS.includes(pBaseExenta.value) ? pBaseExenta.value : 'exigir_base'
    ) as PoliticaBaseExenta;

    const politicasTercero: PoliticasDelTercero = {
      tipoOperacionPorOmision: pTipoOperacion.value,
      terceroSinRfc: pSinRfc.value,
      foreignOperationDefault: pForeignOperation.value,
    };

    // ── EL HECHO ────────────────────────────────────────────────────────
    const { hechos, hallazgos: hallazgosDelMayor } = await hechosDelMes(client, entityId, anio, mes);
    hallazgos.push(...hallazgosDelMayor);

    // ── EL DESGLOSE, DOCUMENTO POR DOCUMENTO ────────────────────────────
    const porTercero = new Map<string, { documentos: DocumentoDelRenglon[]; retenido: Decimal }>();
    for (const h of hechos) {
      const { desglose, hallazgos: hallazgosDelDoc } = desglosarDocumento({
        documentId: h.billId,
        documentNumber: h.billNumber,
        renglones: h.renglones,
        ivaCabecera: h.ivaCabecera,
        ivaPagado: h.ivaPagado,
        porcion: h.porcion,
        politicaBaseExenta,
      });
      hallazgos.push(...hallazgosDelDoc);
      if (h.renglones.length === 0) {
        hallazgos.push({
          codigo: 'DIOT-SIN-RENGLONES',
          severidad: 'bloqueante',
          documentId: h.billId,
          documentNumber: h.billNumber,
          mensaje:
            `El gasto ${h.billNumber} no tiene renglones guardados, así que su IVA no se puede ` +
            `desglosar por tasa. La DIOT declara por tasa, no un total.`,
        });
      }

      const acumulado = porTercero.get(h.vendorId) ?? { documentos: [], retenido: new Decimal(0) };
      acumulado.documentos.push({
        billId: h.billId,
        billNumber: h.billNumber,
        metodo: h.metodo.metodo,
        origenDelMetodo: h.metodo.origin,
        ivaPagado: h.ivaPagado,
        ivaRetenido: h.ivaRetenido,
        desglose,
      });
      acumulado.retenido = acumulado.retenido.plus(h.ivaRetenido);
      porTercero.set(h.vendorId, acumulado);
    }

    // ── EL TERCERO ──────────────────────────────────────────────────────
    const crudos = await terceros(client, entityId, [...porTercero.keys()]);
    const renglones: RenglonDiot[] = [];

    for (const [vendorId, acumulado] of porTercero) {
      const crudo = crudos.get(vendorId);
      if (!crudo) {
        // No debería ocurrir —el gasto referencia al proveedor por clave
        // foránea—, salvo que el gasto sea de otra entidad. Se dice.
        hallazgos.push({
          codigo: 'DIOT-TERCERO-AJENO',
          severidad: 'bloqueante',
          vendorId,
          mensaje:
            `Los gastos ${acumulado.documentos.map((d) => d.billNumber).join(', ')} apuntan al ` +
            `proveedor ${vendorId}, que no pertenece a esta entidad.`,
        });
        continue;
      }

      const { tercero, hallazgos: hallazgosDelTercero } = resolverTercero(crudo, politicasTercero);
      hallazgos.push(...hallazgosDelTercero);
      if (!tercero) continue;

      renglones.push({
        tercero,
        desglose: acumulado.documentos.reduce((acc, d) => sumarDesgloses(acc, d.desglose), desgloseCero()),
        ivaRetenido: acumulado.retenido.toDecimalPlaces(DECIMALES_DIOT).toFixed(DECIMALES_DIOT),
        documentos: acumulado.documentos,
      });
    }

    renglones.sort((a, b) =>
      (a.tercero.rfc ?? a.tercero.idFiscalExtranjero ?? a.tercero.nombre).localeCompare(
        b.tercero.rfc ?? b.tercero.idFiscalExtranjero ?? b.tercero.nombre
      )
    );

    const desgloseTotal = renglones.reduce((acc, r) => sumarDesgloses(acc, r.desglose), desgloseCero());
    const retenidoTotal = renglones.reduce(
      (acc, r) => acc.plus(r.ivaRetenido),
      new Decimal(0)
    );
    const totales: TotalesDiot = {
      desglose: desgloseTotal,
      ivaRetenido: retenidoTotal.toDecimalPlaces(DECIMALES_DIOT).toFixed(DECIMALES_DIOT),
      ivaAcreditablePagado: ivaDelDesglose(desgloseTotal),
      terceros: renglones.length,
      documentos: renglones.reduce((n, r) => n + r.documentos.length, 0),
    };

    return {
      periodo: { anio, mes, ...rangoDelMes(anio, mes) },
      rfc,
      razonSocial,
      renglones,
      totales,
      politicas,
      hallazgos,
    };
  };

  return opciones.client ? ejecutar(opciones.client) : withTransaction(ejecutar);
}

/** Atajo legible: ¿esta DIOT se puede entregar tal cual? */
export function esEntregable(diot: DiotConstruida): boolean {
  return bloquean(diot.hallazgos).length === 0;
}

export type { HechoPagado };
