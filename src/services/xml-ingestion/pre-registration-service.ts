import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import pg from 'pg';
import { query, getClient } from '../../database/connection.js';
import { createJournalEntry } from '../accounting/posting.js';
import { planearAsiento, planContabilizable, type PlanDeAsiento } from './cfdi-posting-plan.js';
import { getPolicy, getPolicyNumber } from '../policy/policy-service.js';
import {
  decideMetodoPago,
  entityUsesCashBasisIva,
  ivaRoleFor,
  ivaTreatmentNote,
} from '../accounting/iva-cash-basis.js';
import type { AccountRole } from './cfdi-taxonomy.js';
import { JournalEntryType } from '../../types/index.js';
import { CFDIParser, CFDIParsed, CFDIConcepto } from './cfdi-parser.js';
import { extractPagosCompletos } from './cfdi-facts.js';
import { ligarPagoREP, type ResultadoREP } from './rep-linkage.js';
import { SATValidationService } from './sat-validation.js';

/**
 * Tipo de comprobante del SAT → el vocabulario de `pre_registrations`.
 *
 * 'I' es ingreso —para quien lo recibe, un gasto— y 'P' es el recibo
 * electrónico de pago. Lo demás sigue cayendo en 'credit_note' por descarte,
 * como antes; lo que cambia es que el REP deje de hacerlo, porque no es una
 * nota de crédito y tratarlo como tal lo mataba con UNSUPPORTED_TYPE.
 */
function tipoDocumentoDe(tipo: string | undefined): string {
  if (tipo === 'I') return 'bill';
  if (tipo === 'P') return 'payment';
  return 'credit_note';
}
import { RulesEngine, Rule, RuleActions, RuleEvaluationResult } from './rules-engine.js';
import { AccountingError, ValidationError } from '../../utils/errors.js';

export class DuplicateError extends Error {
  constructor(message: string, public existingId: string) {
    super(message);
    this.name = 'DuplicateError';
  }
}

/**
 * El código del rechazo por proveedor no autorizado.
 *
 * Va aparte del mensaje porque `processToAccounting` lo MIRA: un pre-registro
 * rechazado por esto no es un documento roto, es un documento que espera a una
 * persona, y tiene que quedar en 'draft'/'needs_review' como el que pide una
 * decisión contable. Si cayera en 'error'/'invalid', un lote lanzado sin la
 * autorización dejaría la bandeja entera marcada como defectuosa cuando lo
 * único que falta es que alguien diga que sí.
 */
export const PROVEEDOR_NUEVO_SIN_AUTORIZAR = 'PROVEEDOR_NUEVO_SIN_AUTORIZAR';

/**
 * Se intentó dar de alta al emisor de un CFDI sin que el llamador lo autorizara.
 *
 * Es un `ValidationError` (422 → salida 3 en el CLI) con código propio, para
 * que el manejador pueda distinguirlo de «este documento está mal».
 */
export class ProveedorNuevoSinAutorizar extends ValidationError {
  constructor(nombre: string, rfc: string) {
    super(
      `El CFDI lo emite "${nombre}" (RFC ${rfc}), que no existe en el catálogo de proveedores de ` +
        'esta entidad. Contabilizarlo aquí daría de alta la contraparte con el nombre y el RFC que ' +
        'trae el XML —dato maestro escrito por un tercero, sin que ninguna persona lo apruebe— y ' +
        'acto seguido reconocería el pasivo en el mayor. Dos salidas: da de alta al proveedor tú, ' +
        `con \`mnemosine vendor create --tax-id ${rfc}\`, y vuelve a ejecutar (el pre-registro lo ` +
        'encontrará por RFC); o repite la orden con --allow-new-vendor si aceptas crearlo tal como ' +
        'viene en el comprobante.',
      'vendor_id',
      { suggested_vendor: { company_name: nombre, tax_id: rfc } }
    );
    this.name = 'ProveedorNuevoSinAutorizar';
    this.code = PROVEEDOR_NUEVO_SIN_AUTORIZAR;
  }
}

/**
 * Lo que el LLAMADOR autoriza, que no es lo mismo que lo que el documento pide.
 *
 * Viaja con la orden de contabilizar, nunca con la fila: dos llamadas sobre el
 * mismo pre-registro pueden legítimamente decidir distinto según quién las
 * haga. Por omisión todo es `false` — el que no dice nada no crea contrapartes.
 */
export interface OpcionesDeProceso {
  /**
   * Autoriza dar de alta al emisor del CFDI cuando no está en el catálogo.
   *
   * Sólo lo pone un camino INTERACTIVO donde una persona escribió la
   * autorización (`bill inbox run --allow-new-vendor`, o `allow_new_vendor`
   * en el cuerpo de la petición REST). Ningún camino automático —reglas del
   * despacho, lote programado, agente, webhook— lo pone jamás.
   */
  permitirProveedorNuevo?: boolean;
}

export interface LineWithSuggestion {
  line_number: number;
  clave_prod_serv: string;
  clave_unidad: string;
  descripcion: string;
  cantidad: number;
  valor_unitario: number;
  importe: number;
  descuento?: number;
  impuestos?: CFDIConcepto['impuestos'];
  suggested_account_id: string | null;
  suggested_account_confidence: number;
  suggestion_reason: string;
  account_id?: string;
  cost_center_id?: string;
}

export class PreRegistrationService {
  private parser = new CFDIParser();
  private satValidator = new SATValidationService();
  private rulesEngine = new RulesEngine();

  /**
   * Main entry point: process uploaded XML
   */
  async processXMLUpload(
    entityId: string,
    xmlContent: string,
    source: 'manual_upload' | 'email' | 'api' | 'sftp',
    uploadedBy: string
  ): Promise<{
    xmlDocument: Record<string, unknown>;
    preRegistration: Record<string, unknown>;
    autoProcessed: boolean;
    bill?: Record<string, unknown>;
    journalEntry?: Record<string, unknown>;
  }> {
    const parsed = this.parser.parse(xmlContent);
    const validation = this.parser.validate(parsed);
    if (!validation.valid) {
      throw new ValidationError(`Invalid CFDI: ${validation.errors.join('; ')}`);
    }

    const hash = this.parser.calculateHash(xmlContent);
    const cfdiUuid = parsed.timbreFiscalDigital!.uuid;

    // F02 · EL ESPEJO: el dedupe es POR ENTIDAD (046), no global. Las dos
    // partes de una operación pueden ser clientes del despacho, y el MISMO
    // XML entra dos veces — el emisor como 'emitido', el receptor como
    // 'recibido'. Lo que sigue prohibido es la misma entidad dos veces.
    const existing = await query<{ id: string }>(
      `SELECT id FROM xml_documents
        WHERE entity_id = $1 AND (cfdi_uuid = $2 OR xml_hash = $3) LIMIT 1`,
      [entityId, cfdiUuid, hash]
    );
    if (existing.rows.length > 0) {
      throw new DuplicateError(`CFDI already exists: ${existing.rows[0].id}`, existing.rows[0].id);
    }

    const taxBreakdown = this.parser.calculateTaxBreakdown(parsed);
    const documentType = this.parser.mapTipoComprobante(parsed.tipoDeComprobante);

    // Save XML document
    const xmlDocId = uuidv4();
    await query(
      `INSERT INTO xml_documents (
        id, entity_id, document_type,
        cfdi_uuid, cfdi_version, cfdi_serie, cfdi_folio, cfdi_fecha, cfdi_fecha_timbrado,
        emisor_rfc, emisor_nombre, emisor_regimen_fiscal,
        receptor_rfc, receptor_nombre, receptor_uso_cfdi,
        receptor_regimen_fiscal, receptor_domicilio_fiscal,
        subtotal, descuento, total, moneda, tipo_cambio,
        total_impuestos_trasladados, total_impuestos_retenidos,
        total_iva_16, total_iva_8, total_iva_0, total_isr_retenido, total_iva_retenido,
        forma_pago, metodo_pago,
        xml_content, xml_hash,
        import_source, imported_by, processing_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,'pending')`,
      [
        xmlDocId, entityId, documentType,
        cfdiUuid, parsed.version, parsed.serie || null, parsed.folio || null,
        parsed.fecha, parsed.timbreFiscalDigital!.fechaTimbrado,
        parsed.emisor.rfc, parsed.emisor.nombre, parsed.emisor.regimenFiscal,
        parsed.receptor.rfc, parsed.receptor.nombre, parsed.receptor.usoCFDI,
        parsed.receptor.regimenFiscalReceptor || null, parsed.receptor.domicilioFiscalReceptor || null,
        parsed.subTotal, parsed.descuento || 0, parsed.total,
        parsed.moneda, parsed.tipoCambio || 1,
        parsed.impuestos.totalImpuestosTrasladados || 0,
        parsed.impuestos.totalImpuestosRetenidos || 0,
        taxBreakdown.iva_16, taxBreakdown.iva_8, taxBreakdown.iva_0,
        taxBreakdown.isr_retenido, taxBreakdown.iva_retenido,
        parsed.formaPago || null, parsed.metodoPago || null,
        xmlContent, hash,
        source, uploadedBy,
      ]
    );

    // Save XML lines (conceptos)
    for (let i = 0; i < parsed.conceptos.length; i++) {
      const c = parsed.conceptos[i];
      await query(
        `INSERT INTO xml_document_lines (
          id, xml_document_id, line_number,
          clave_prod_serv, clave_unidad, unidad, no_identificacion, descripcion,
          cantidad, valor_unitario, importe, descuento,
          impuestos, objeto_imp
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          uuidv4(), xmlDocId, i + 1,
          c.claveProdServ, c.claveUnidad, c.unidad || null, c.noIdentificacion || null,
          c.descripcion, c.cantidad, c.valorUnitario, c.importe, c.descuento || 0,
          c.impuestos ? JSON.stringify(c.impuestos) : null, c.objetoImp || null,
        ]
      );
    }

    // Fetch saved doc
    const xmlDocResult = await query('SELECT * FROM xml_documents WHERE id = $1', [xmlDocId]);
    const xmlDocument = xmlDocResult.rows[0];

    // Async SAT validation (non-blocking)
    this.satValidator.validateAndUpdate(xmlDocId).catch((err) =>
      console.error('SAT validation error:', err)
    );

    // Create pre-registration
    const preRegistration = await this.createPreRegistration(entityId, xmlDocument, parsed, uploadedBy);

    // Apply rules
    const rules = await this.getRulesForEntity(entityId);
    const ruleResults = await this.rulesEngine.evaluate(preRegistration, xmlDocument, rules);
    const updated = await this.applyRuleActions(preRegistration, ruleResults.aggregatedActions, ruleResults.results);

    // Auto-process if applicable
    let autoProcessed = false;
    let bill: Record<string, unknown> | undefined;
    let journalEntry: Record<string, unknown> | undefined;

    if (
      updated.processing_mode === 'auto' &&
      updated.validation_status === 'valid' &&
      !updated.requires_approval &&
      updated.status === 'ready'
    ) {
      try {
        // NUNCA crea proveedores. Esta rama no la decide una persona: la
        // decide el motor de reglas del inquilino, que un renglón antes pudo
        // haber puesto processing_mode='auto' él mismo (applyRuleActions).
        // Una regla que se autoconcede el modo automático no puede además
        // fabricar contrapartes desde el XML. El CFDI cuyo emisor no está en
        // el catálogo queda en la bandeja, que es donde una persona lo ve.
        const result = await this.processToAccounting(updated, uploadedBy, {
          permitirProveedorNuevo: false,
        });
        autoProcessed = true;
        bill = result.bill;
        journalEntry = result.journalEntry ?? undefined;
      } catch (err) {
        console.error('Auto-processing failed:', err);
      }
    }

    return { xmlDocument, preRegistration: updated, autoProcessed, bill, journalEntry };
  }

  private async createPreRegistration(
    entityId: string,
    xmlDocument: Record<string, unknown>,
    parsed: CFDIParsed,
    userId: string
  ): Promise<Record<string, unknown>> {
    const vendorMatch = await this.matchVendor(entityId, parsed.emisor);
    const lines = await this.buildLinesWithSuggestions(entityId, parsed.conceptos, vendorMatch.vendor);
    const dueDate = this.calculateDueDate(parsed.fecha, vendorMatch.vendor?.payment_terms as string);

    const preRegId = uuidv4();
    await query(
      `INSERT INTO pre_registrations (
        id, entity_id, xml_document_id, source_type, document_type,
        vendor_id, vendor_match_confidence, vendor_match_method, is_new_vendor, suggested_vendor_data,
        external_reference, document_date, due_date,
        currency_code, exchange_rate,
        subtotal, tax_amount, total_amount, tax_breakdown,
        lines, processing_mode, validation_status, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        preRegId, entityId, xmlDocument.id, 'xml_cfdi',
        // Un CFDI tipo P es un RECIBO DE PAGO, no una nota de crédito. Caía en
        // 'credit_note' por descarte y moría en processToAccounting con
        // UNSUPPORTED_TYPE: el pre-registro quedaba en 'error' y el
        // comprobante que sostiene el acreditamiento del IVA no llegaba a
        // ninguna parte. El vocabulario de la columna ya admitía 'payment'.
        tipoDocumentoDe(parsed.tipoDeComprobante),
        vendorMatch.vendor?.id || null,
        vendorMatch.confidence, vendorMatch.method,
        vendorMatch.isNew, vendorMatch.suggestedData ? JSON.stringify(vendorMatch.suggestedData) : null,
        `${parsed.serie || ''}${parsed.folio || ''}`, parsed.fecha, dueDate,
        parsed.moneda, parsed.tipoCambio || 1,
        parsed.subTotal, parsed.impuestos.totalImpuestosTrasladados || 0, parsed.total,
        JSON.stringify(parsed.impuestos),
        JSON.stringify(lines),
        'manual', 'pending', 'draft', userId,
      ]
    );

    const result = await query('SELECT * FROM pre_registrations WHERE id = $1', [preRegId]);
    return result.rows[0];
  }

  private async matchVendor(
    entityId: string,
    emisor: CFDIParsed['emisor']
  ): Promise<{
    vendor: Record<string, unknown> | null;
    confidence: number;
    method: string;
    isNew: boolean;
    suggestedData: Record<string, unknown> | null;
  }> {
    // Exact RFC
    const exactMatch = await query<Record<string, unknown>>(
      `SELECT * FROM vendors WHERE entity_id = $1 AND tax_id = $2 AND is_active = true LIMIT 1`,
      [entityId, emisor.rfc]
    );
    if (exactMatch.rows.length > 0) {
      return { vendor: exactMatch.rows[0], confidence: 1.0, method: 'exact_rfc', isNew: false, suggestedData: null };
    }

    // Fuzzy name (using trigram similarity from pg_trgm)
    const fuzzyMatch = await query<Record<string, unknown>>(
      `SELECT *, similarity(company_name, $2) as name_similarity
       FROM vendors WHERE entity_id = $1 AND is_active = true
         AND similarity(company_name, $2) > 0.5
       ORDER BY name_similarity DESC LIMIT 1`,
      [entityId, emisor.nombre]
    );
    if (fuzzyMatch.rows.length > 0 && Number(fuzzyMatch.rows[0].name_similarity) > 0.7) {
      return {
        vendor: fuzzyMatch.rows[0],
        confidence: Number(fuzzyMatch.rows[0].name_similarity),
        method: 'fuzzy_name',
        isNew: false,
        suggestedData: null,
      };
    }

    return {
      vendor: null,
      confidence: 0,
      method: 'no_match',
      isNew: true,
      suggestedData: {
        company_name: emisor.nombre,
        tax_id: emisor.rfc,
        tax_id_type: 'rfc',
        regimen_fiscal: emisor.regimenFiscal,
      },
    };
  }

  private async buildLinesWithSuggestions(
    entityId: string,
    conceptos: CFDIConcepto[],
    vendor: Record<string, unknown> | null
  ): Promise<LineWithSuggestion[]> {
    const lines: LineWithSuggestion[] = [];

    for (let i = 0; i < conceptos.length; i++) {
      const c = conceptos[i];
      const suggestion = await this.suggestAccount(entityId, c.claveProdServ, c.descripcion, vendor);

      lines.push({
        line_number: i + 1,
        clave_prod_serv: c.claveProdServ,
        clave_unidad: c.claveUnidad,
        descripcion: c.descripcion,
        cantidad: c.cantidad,
        valor_unitario: c.valorUnitario,
        importe: c.importe,
        descuento: c.descuento,
        impuestos: c.impuestos,
        suggested_account_id: suggestion.accountId,
        suggested_account_confidence: suggestion.confidence,
        suggestion_reason: suggestion.reason,
      });
    }

    return lines;
  }

  private async suggestAccount(
    entityId: string,
    claveProdServ: string,
    descripcion: string,
    vendor: Record<string, unknown> | null
  ): Promise<{ accountId: string | null; confidence: number; reason: string }> {
    // 1. Vendor default
    if (vendor?.default_expense_account_id) {
      return { accountId: vendor.default_expense_account_id as string, confidence: 0.8, reason: 'vendor_default' };
    }

    // 2. SAT code mapping
    const satMapping = await query<{ account_id: string; confidence: string }>(
      `SELECT account_id, confidence FROM sat_code_mappings
       WHERE entity_id = $1 AND is_active = true
         AND (sat_code = $2 OR $2 LIKE sat_code_prefix || '%')
       ORDER BY LENGTH(COALESCE(sat_code_prefix, sat_code)) DESC LIMIT 1`,
      [entityId, claveProdServ]
    );
    if (satMapping.rows.length > 0) {
      return {
        accountId: satMapping.rows[0].account_id,
        confidence: Number(satMapping.rows[0].confidence),
        reason: 'sat_code_mapping',
      };
    }

    // 3. Historical pattern (same vendor or similar description)
    const historical = await query<{ account_id: string; frequency: string }>(
      `SELECT bl.account_id, COUNT(*) as frequency
       FROM bill_lines bl
       JOIN bills b ON b.id = bl.bill_id
       WHERE b.entity_id = $1
         AND ($2::uuid IS NULL OR b.vendor_id = $2::uuid OR similarity(bl.description, $3) > 0.7)
       GROUP BY bl.account_id ORDER BY frequency DESC LIMIT 1`,
      [entityId, vendor?.id || null, descripcion]
    );
    if (historical.rows.length > 0) {
      const freq = Number(historical.rows[0].frequency);
      return {
        accountId: historical.rows[0].account_id,
        confidence: Math.min(0.9, 0.5 + freq * 0.1),
        reason: 'historical_pattern',
      };
    }

    return { accountId: null, confidence: 0, reason: 'no_match' };
  }

  private calculateDueDate(documentDate: Date, paymentTerms?: string): Date {
    const due = new Date(documentDate);
    let days = 30; // default Net 30
    if (paymentTerms) {
      const match = paymentTerms.match(/\d+/);
      if (match) days = parseInt(match[0], 10);
    }
    due.setDate(due.getDate() + days);
    return due;
  }

  private async getRulesForEntity(entityId: string): Promise<Rule[]> {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM processing_rules WHERE entity_id = $1 AND is_active = true ORDER BY priority ASC`,
      [entityId]
    );

    return result.rows.map((r) => ({
      id: r.id as string,
      name: r.rule_name as string,
      priority: r.priority as number,
      conditions: r.conditions as Rule['conditions'],
      actions: r.actions as Rule['actions'],
      isActive: r.is_active as boolean,
    }));
  }

  private async applyRuleActions(
    preReg: Record<string, unknown>,
    actions: RuleActions,
    results: RuleEvaluationResult[]
  ): Promise<Record<string, unknown>> {
    const matchedResults = results.filter((r) => r.matched);

    let newStatus = preReg.status as string;
    let newValidationStatus = 'valid';
    let validationErrors: unknown = null;

    if (actions.reject) {
      newStatus = 'rejected';
      newValidationStatus = 'invalid';
      validationErrors = [{ code: 'RULE_REJECTION', message: actions.reject_reason || 'Rejected by rule' }];
    } else {
      newStatus = 'ready';
    }

    const newLines = actions.set_account
      ? (preReg.lines as LineWithSuggestion[]).map((l) => ({
          ...l,
          account_id: actions.set_account || l.suggested_account_id || undefined,
        }))
      : preReg.lines;

    await query(
      `UPDATE pre_registrations SET
        default_account_id = COALESCE($2, default_account_id),
        account_mapping_method = COALESCE($3, account_mapping_method),
        processing_mode = COALESCE($4, processing_mode),
        requires_approval = COALESCE($5, requires_approval),
        approval_status = CASE WHEN $5 = true THEN 'pending' ELSE approval_status END,
        batch_priority = COALESCE($6, batch_priority),
        tags = COALESCE($7::jsonb, tags),
        status = $8,
        validation_status = $9,
        validation_errors = $10::jsonb,
        rules_applied = $11::jsonb,
        lines = $12::jsonb,
        updated_at = NOW()
       WHERE id = $1`,
      [
        preReg.id,
        actions.set_account || null,
        actions.set_account ? 'rule' : null,
        actions.set_processing_mode || null,
        actions.require_approval || null,
        actions.set_priority || null,
        actions.add_tags ? JSON.stringify(actions.add_tags) : null,
        newStatus,
        newValidationStatus,
        validationErrors ? JSON.stringify(validationErrors) : null,
        JSON.stringify(matchedResults),
        JSON.stringify(newLines),
      ]
    );

    const result = await query('SELECT * FROM pre_registrations WHERE id = $1', [preReg.id]);
    return result.rows[0];
  }

  /**
   * Process pre-registration to accounting (creates bill + journal entry)
   */
  async processToAccounting(
    preReg: Record<string, unknown>,
    userId: string,
    opciones: OpcionesDeProceso = {}
  ): Promise<{
    bill?: Record<string, unknown>;
    journalEntry?: Record<string, unknown> | null;
    paymentId?: string;
  }> {
    await query(`UPDATE pre_registrations SET status = 'processing' WHERE id = $1`, [preReg.id]);

    try {
      // Un REP no genera póliza propia: o casa con un pago ya registrado —cuyo
      // asiento ya existe— o crea el pago, y entonces la póliza es la de ese
      // pago. Por eso el asiento es opcional aquí.
      let result: {
        bill?: Record<string, unknown>;
        journalEntry?: Record<string, unknown> | null;
        paymentId?: string;
      };

      switch (preReg.document_type) {
        case 'bill':
          result = await this.createBillFromPreReg(preReg, userId, opciones);
          break;
        case 'payment':
          result = await this.procesarREP(preReg, userId);
          break;
        default:
          throw new AccountingError('UNSUPPORTED_TYPE', `Unsupported document type: ${preReg.document_type}`);
      }

      await query(
        `UPDATE pre_registrations SET
          status = 'completed',
          result_type = $2, result_id = $3,
          bill_id = $4, journal_entry_id = $5,
          processed_at = NOW(), processed_by = $6
         WHERE id = $1`,
        [
          preReg.id,
          result.bill ? 'bill' : result.paymentId ? 'payment' : 'journal_entry',
          result.bill?.id ?? result.paymentId ?? result.journalEntry?.id ?? null,
          result.bill?.id || null,
          result.journalEntry?.id ?? null,
          userId,
        ]
      );

      await query(`UPDATE xml_documents SET processing_status = 'completed' WHERE id = $1`, [preReg.xml_document_id]);

      // F02: el rastro del clasificador se cierra con el asiento que produjo.
      if (result.journalEntry?.id) {
        await query(
          `UPDATE cfdi_classifications cc
              SET journal_entry_id = $1, status = 'posted', updated_at = NOW()
             FROM xml_documents xd
            WHERE xd.id = $2 AND cc.entity_id = xd.entity_id AND cc.cfdi_uuid = xd.cfdi_uuid`,
          [result.journalEntry.id, preReg.xml_document_id]
        );
      }

      return result;
    } catch (error) {
      // Un CFDI que necesita una decisión no es un error del sistema: es un
      // documento que espera a una persona. Se distingue para que no se
      // pierda entre fallos reales y para que la razón quede legible.
      // Un proveedor sin autorizar cae en el mismo cajón por la misma razón:
      // el documento está bien, lo que falta es el sí de una persona.
      const codigo = (error as { code?: string }).code;
      const requiereDecision =
        codigo === 'CFDI_REQUIERE_DECISION' || codigo === PROVEEDOR_NUEVO_SIN_AUTORIZAR;

      await query(
        `UPDATE pre_registrations SET
          status = $4, validation_status = $5,
          error_message = $2, error_details = $3::jsonb
         WHERE id = $1`,
        [
          preReg.id,
          (error as Error).message,
          JSON.stringify(
            requiereDecision ? { motivo: (error as Error).message } : { stack: (error as Error).stack }
          ),
          requiereDecision ? 'draft' : 'error',
          requiereDecision ? 'needs_review' : 'invalid',
        ]
      );
      throw error;
    }
  }

  /**
   * Las líneas del asiento de una factura recibida.
   *
   * Cuando hay CFDI, manda el clasificador: él decide el caso, si el IVA va
   * a acreditable o a pendiente de acreditar, y contra qué cuenta de
   * control. El desglose por renglón —reglas del inquilino y sugerencias—
   * sigue decidiendo a qué cuenta de gasto va cada concepto.
   *
   * Sin CFDI (alta manual, importación) no hay nada que clasificar y se
   * conserva el armado directo, que asume pago en una exhibición porque es
   * lo único que se puede asumir cuando no hay método de pago declarado.
   */
  private async lineasDelAsiento(
    preReg: Record<string, unknown>,
    lines: LineWithSuggestion[],
    billNumber: string
  ): Promise<{
    lineas: Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }>;
    /** F02: true cuando la política cfdi_periodo_cerrado manda la póliza al periodo abierto. */
    fechaContableHoy: boolean;
  }> {
    const plan = await this.planDeAsiento(preReg, lines, billNumber);

    if (!plan) {
      return { lineas: await this.lineasSinCfdi(preReg, lines, billNumber), fechaContableHoy: false };
    }

    // F02 · EL RASTRO DEL CLASIFICADOR (E1.2 pagado): la 015 prometió que
    // cfdi_classifications guardaría POR QUÉ un XML se registró como se
    // registró, y el clasificador calculaba todo esto en cada ingesta y lo
    // tiraba. Se escribe ANTES del veredicto de contabilizable: el rastro
    // de un CFDI bloqueado vale tanto como el de uno posteado — es el que
    // el reproceso y el auditor van a leer.
    await this.guardarClasificacion(preReg, plan);

    const { ok, motivo } = planContabilizable(plan);
    if (!ok) {
      // No se contabiliza a medias: el pre-registro queda marcado para
      // revisión con la razón y las decisiones que faltan (ver el catch de
      // processToAccounting).
      throw new AccountingError('CFDI_REQUIERE_DECISION', motivo);
    }

    // Los avisos del clasificador —IVA de moneda extranjera, partidas
    // exentas, un desglose que no cuadró— se guardan con el documento. Un
    // aviso que no queda en ninguna parte no es un aviso.
    if (plan.avisos.length > 0) {
      await query(
        `UPDATE pre_registrations
            SET validation_status = 'warnings', validation_warnings = $2::jsonb
          WHERE id = $1`,
        [preReg.id, JSON.stringify(plan.avisos)]
      );
    }

    return {
      lineas: plan.lineas.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description,
      })),
      fechaContableHoy: plan.fechaContableHoy === true,
    };
  }

  /**
   * F02: el UPSERT del rastro. Llave (entity_id, cfdi_uuid) — la de la 015.
   * El veredicto del clasificador se mapea al vocabulario de la tabla:
   * ready→ready, needs_input→pending, blocked→blocked, no_posting→skipped;
   * 'posted' lo escribe processToAccounting al completar, con el asiento.
   */
  private async guardarClasificacion(
    preReg: Record<string, unknown>,
    plan: PlanDeAsiento
  ): Promise<void> {
    const c = plan.clasificacion;
    const estado =
      c.verdict === 'ready' ? 'ready'
      : c.verdict === 'needs_input' ? 'pending'
      : c.verdict === 'blocked' ? 'blocked'
      : 'skipped';
    const tenant = await query<{ tenant_id: string }>(
      `SELECT tenant_id FROM legal_entities WHERE id = $1`,
      [preReg.entity_id]
    );
    await query(
      `INSERT INTO cfdi_classifications (
        id, tenant_id, entity_id, cfdi_uuid, tipo_comprobante, direction,
        case_id, facts, decisions, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (entity_id, cfdi_uuid)
      DO UPDATE SET case_id = EXCLUDED.case_id, facts = EXCLUDED.facts,
                    decisions = EXCLUDED.decisions, status = EXCLUDED.status,
                    updated_at = NOW()`,
      [
        uuidv4(), tenant.rows[0]?.tenant_id, preReg.entity_id,
        c.facts.uuid, c.facts.tipo, c.facts.direction,
        c.case?.id ?? null, JSON.stringify(c.facts), JSON.stringify(c.decisions),
        estado,
      ]
    );
  }

  /** null cuando el pre-registro no viene de un CFDI. */
  private async planDeAsiento(
    preReg: Record<string, unknown>,
    lines: LineWithSuggestion[],
    billNumber: string
  ): Promise<PlanDeAsiento | null> {
    if (!preReg.xml_document_id) return null;

    const doc = await query<{ xml_content: string; sat_validation_status: string | null }>(
      `SELECT xml_content, sat_validation_status FROM xml_documents WHERE id = $1`,
      [preReg.xml_document_id]
    );
    if (doc.rows.length === 0 || !doc.rows[0].xml_content) return null;

    const entidad = await query<{ tax_id: string; tenant_id: string }>(
      `SELECT tax_id, tenant_id FROM legal_entities WHERE id = $1`,
      [preReg.entity_id]
    );
    if (entidad.rows.length === 0) {
      throw new AccountingError('ENTITY_NOT_FOUND', `Entity ${String(preReg.entity_id)} not found`);
    }

    const periodo = await query<{ id: string }>(
      `SELECT id FROM fiscal_periods
        WHERE entity_id = $1 AND start_date <= $2 AND end_date >= $2
          AND status NOT IN ('hard_close', 'locked')
        LIMIT 1`,
      [preReg.entity_id, preReg.document_date]
    );
    const periodOpen = periodo.rows.length > 0;

    // F02 · E1.3: LOS UMBRALES SALEN DEL PANEL. La inyección existía
    // diseñada (PolicyThresholds) y el llamador de producción nunca la
    // inyectaba: el despacho contestaba y no cambiaba nada. Además, una
    // política CONTESTADA se vuelve respuesta automática de su decisión —
    // el clasificador deja de preguntar lo que el despacho ya respondió.
    const ctx = { tenantId: entidad.rows[0].tenant_id, entityId: preReg.entity_id as string };
    const [umbralCap, polRestaurantes, polIeps, polInventarios] = await Promise.all([
      getPolicyNumber(ctx, 'umbral_capitalizacion_mxn'),
      getPolicy(ctx, 'politica_restaurantes'),
      getPolicy(ctx, 'tratamiento_ieps'),
      getPolicy(ctx, 'lleva_inventarios'),
    ]);
    const answers: Record<string, string> = {};
    if (polRestaurantes.defined) answers.consumo_restaurante = polRestaurantes.value;
    if (polIeps.defined) answers.ieps_acreditable = polIeps.value;

    // cfdi_periodo_cerrado: solo el literal 'periodo_actual' registra solo;
    // 'preguntar', 'reabrir' o un valor desconocido escalan como siempre.
    let fechaContableHoy = false;
    if (!periodOpen) {
      const polPeriodo = await getPolicy(ctx, 'cfdi_periodo_cerrado');
      if (polPeriodo.value === 'periodo_actual') {
        answers.periodo_cerrado = 'periodo_actual';
        fechaContableHoy = true;
      }
    }

    const plan = await planearAsiento({
      entityId: preReg.entity_id as string,
      entityRfc: entidad.rows[0].tax_id,
      xml: doc.rows[0].xml_content,
      referencia: billNumber,
      renglones: lines.map((l) => ({
        line_number: l.line_number,
        descripcion: l.descripcion,
        importe: l.importe,
        account_id: l.account_id ?? null,
        suggested_account_id: l.suggested_account_id,
        cost_center_id: l.cost_center_id,
      })),
      cuentaGastoPorDefecto: (preReg.default_account_id as string) ?? null,
      // El proveedor ya quedó resuelto o creado antes de llegar aquí.
      vendorExists: true,
      periodOpen: fechaContableHoy ? true : periodOpen,
      satStatus: mapearEstadoSat(doc.rows[0].sat_validation_status),
      answers,
      thresholds: {
        capitalizationThreshold: umbralCap,
        restaurantPolicy: polRestaurantes.value,
        iepsTreatment: polIeps.value,
        inventoryPolicy: polInventarios.value,
      },
    });
    if (fechaContableHoy) {
      plan.fechaContableHoy = true;
      plan.avisos.push(
        'CFDI de periodo cerrado: la póliza se registra en el periodo abierto por la política ' +
          'cfdi_periodo_cerrado=periodo_actual; la fecha fiscal del documento no cambia.'
      );
    }
    return plan;
  }

  /** Armado directo para documentos sin CFDI. */
  private async lineasSinCfdi(
    preReg: Record<string, unknown>,
    lines: LineWithSuggestion[],
    billNumber: string
  ): Promise<Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }>> {
    const entityId = preReg.entity_id as string;
    const cliente = await getClient();
    try {
      // Sin CFDI no hay MetodoPago declarado, pero eso no autoriza a inventar
      // un tratamiento propio: el mismo gasto no puede caer en una cuenta u
      // otra según por qué puerta entró. Antes esta función resolvía por los
      // códigos literales '2110' y '1130' y mandaba TODO el IVA a acreditable
      // sin mirar el método, contradiciendo a AR/AP y a la ingesta con CFDI.
      //
      // Ahora usa la MISMA decisión (decideMetodoPago, con su supuesto
      // conservador) y el MISMO mapa de roles (ivaRoleFor, que se lo pregunta
      // a la taxonomía CFDI). Una entidad no mexicana no se toca: su impuesto
      // no es IVA acreditable y sigue posteando donde siempre.
      const flujo = await entityUsesCashBasisIva(cliente, entityId);
      const decision = decideMetodoPago('received', {
        terms: null,
        memo: (preReg.notes as string) ?? null,
      });
      const rolIva: AccountRole = flujo
        ? ivaRoleFor('received', decision.metodo)
        : 'iva_acreditable';

      const cuentas = await cuentasPorRol(cliente, entityId, ['cxp', rolIva]);
      const cxp = cuentas.get('cxp');
      if (!cxp) {
        throw new AccountingError(
          'AP_ACCOUNT_MISSING',
          `La entidad no tiene cuenta para el rol "cxp" (proveedores). ` +
            `Siembra la contabilidad con: mnemosine init --section identity`
        );
      }

      const jeLines: Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }> = [
        {
          account_id: cxp,
          debit_amount: null,
          credit_amount: new Decimal(preReg.total_amount as string).toFixed(4),
          description: `Bill ${billNumber}`,
        },
      ];

      for (const line of lines) {
        const accountId = line.account_id || line.suggested_account_id || (preReg.default_account_id as string);
        jeLines.push({
          account_id: accountId,
          debit_amount: new Decimal(line.importe).toFixed(4),
          credit_amount: null,
          description: line.descripcion,
        });
      }

      const totalTax = new Decimal(preReg.tax_amount as string);
      if (totalTax.greaterThan(0)) {
        const cuentaIva = cuentas.get(rolIva);
        if (!cuentaIva) {
          // Antes se descartaba la línea en silencio con un `&& iva`, y el
          // asiento salía descuadrado lejos del origen.
          throw new AccountingError(
            'MISSING_ROLE_ACCOUNT',
            `La entidad no tiene cuenta para el rol "${rolIva}". ` +
              `Siembra la contabilidad con: mnemosine init --section identity`
          );
        }
        jeLines.push({
          account_id: cuentaIva,
          debit_amount: totalTax.toFixed(4),
          credit_amount: null,
          // El supuesto queda escrito en el renglón, no sólo en este archivo.
          description: `${ivaTreatmentNote('received', decision)} — Bill ${billNumber}`,
        });
      }
      return jeLines;
    } finally {
      cliente.release();
    }
  }

  /**
   * UN REP INGERIDO NO CONTABILIZA: LIGA.
   *
   * Todo lo demás que pasa por aquí crea una póliza. Éste no, y es
   * deliberado. Un recibo electrónico de pago documenta un movimiento de
   * banco que o bien ya se registró —y entonces su póliza existe— o bien hay
   * que registrar por la puerta de pagos, que es la que sabe aplicar el pago
   * a los documentos y, con eso, liberar el IVA aparcado.
   *
   * Postear aquí el efectivo, como especificaba el plan anterior, abona el
   * banco por segunda vez cuando el pago también se capturó a mano; y si
   * además se escriben las líneas de IVA, el impuesto se traspasa dos veces
   * sin que nada proteste, porque el tope de lo aparcado recorta el exceso en
   * silencio y la póliza acaba cuadrando. Un número equivocado que cuadra no
   * lo encuentra nadie.
   *
   * Un comprobante puede traer varios nodos `Pago`: son varios movimientos de
   * banco y se resuelven uno por uno. Si alguno queda para revisión, el
   * comprobante entero espera a una persona — se lanza la misma señal que usa
   * un CFDI que necesita una decisión, así que el pre-registro cae en
   * `needs_review` con el motivo legible en vez de en `error`.
   */
  private async procesarREP(
    preReg: Record<string, unknown>,
    userId: string
  ): Promise<{ journalEntry?: Record<string, unknown> | null; paymentId?: string }> {
    const doc = await query<{
      xml_content: string;
      cfdi_uuid: string;
      emisor_rfc: string;
      receptor_rfc: string;
      cfdi_fecha: Date;
    }>(
      `SELECT xml_content, cfdi_uuid, emisor_rfc, receptor_rfc, cfdi_fecha
         FROM xml_documents WHERE id = $1`,
      [preReg.xml_document_id]
    );
    if (doc.rows.length === 0 || !doc.rows[0].xml_content) {
      throw new AccountingError('REP_SIN_XML', 'No se conserva el XML del comprobante de pago.');
    }

    const entidad = await query<{ tax_id: string; functional_currency: string; tenant_id: string }>(
      `SELECT tax_id, functional_currency, tenant_id FROM legal_entities WHERE id = $1`,
      [preReg.entity_id]
    );
    if (entidad.rows.length === 0) {
      throw new AccountingError('ENTITY_NOT_FOUND', 'La entidad del pre-registro no existe.');
    }
    const { tax_id: rfc, functional_currency: moneda, tenant_id: tenantId } = entidad.rows[0];

    const pagos = extractPagosCompletos(new CFDIParser().parse(doc.rows[0].xml_content));
    if (pagos.length === 0) {
      throw new AccountingError(
        'REP_SIN_PAGOS',
        'El comprobante es de tipo P pero no trae complemento de pagos: no hay nada que ligar.'
      );
    }

    // Emisor o receptor. Del lado emitido el REP lo expedimos nosotros y
    // documenta un cobro; del recibido lo expide el proveedor y documenta un
    // pago nuestro. Son dos subledgers distintos.
    // Emisor, receptor… o ninguno. La primera versión decidía por descarte
    // —«si no lo emitimos, lo recibimos»— y un comprobante AJENO (de otro RFC
    // a otro RFC, algo común en un buzón compartido o una descarga masiva
    // equivocada) se habría procesado como pago nuestro a un proveedor.
    if (doc.rows[0].emisor_rfc !== rfc && doc.rows[0].receptor_rfc !== rfc) {
      throw new AccountingError(
        'CFDI_REQUIERE_DECISION',
        `El comprobante es de ${doc.rows[0].emisor_rfc} para ${doc.rows[0].receptor_rfc} y la ` +
          `entidad es ${rfc}: no es parte de la operación. Revisa si se subió a la entidad equivocada.`
      );
    }
    const direction = doc.rows[0].emisor_rfc === rfc ? 'emitido' : 'recibido';

    const resultados: ResultadoREP[] = [];
    for (const [indice, pago] of pagos.entries()) {
      resultados.push(
        await ligarPagoREP({
          tenantId,
          entityId: preReg.entity_id as string,
          userId,
          cfdiUuid: doc.rows[0].cfdi_uuid,
          direction,
          indice,
          pago,
          fechaCfdi: new Date(doc.rows[0].cfdi_fecha),
          monedaFuncional: moneda,
        })
      );
    }

    const paraRevision = resultados.filter((r) => r.accion === 'revision');
    if (paraRevision.length > 0) {
      // Los nodos anteriores pueden haber creado o casado pagos YA: cada
      // ligadura es su propia transacción y no se puede des-postear un pago
      // legítimo porque otro nodo necesite una decisión. Lo que sí se puede
      // —y es obligatorio— es que el estado lo DIGA: un needs_review que
      // calla que la mitad del dinero ya se movió haría que el revisor
      // reprocesara desde cero, y sólo la idempotencia lo salvaría de
      // duplicar. El motivo enumera lo hecho y lo pendiente.
      const hechos = resultados
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r.accion !== 'revision');
      const prefijo =
        hechos.length > 0
          ? `OJO: ${hechos.length} de ${resultados.length} nodos de pago YA quedaron resueltos ` +
            `(${hechos.map((x) => `nodo ${x.i}: ${x.r.accion}${x.r.paymentId ? ` → ${x.r.paymentId}` : ''}`).join('; ')}). ` +
            'Reprocesar es seguro: la idempotencia los salta. Pendiente: '
          : '';
      throw new AccountingError(
        'CFDI_REQUIERE_DECISION',
        prefijo + paraRevision.map((r) => r.motivo).join(' · ')
      );
    }

    const conPago = resultados.find((r) => r.paymentId);
    const asiento = conPago?.paymentId
      ? (
          await query(
            `SELECT je.* FROM journal_entries je
              WHERE je.source_type IN ('vendor_payment','customer_payment')
                AND je.source_id = $1
              ORDER BY je.created_at DESC LIMIT 1`,
            [conPago.paymentId]
          )
        ).rows[0] ?? null
      : null;

    return { journalEntry: asiento, paymentId: conPago?.paymentId };
  }

  private async createBillFromPreReg(
    preReg: Record<string, unknown>,
    userId: string,
    opciones: OpcionesDeProceso = {}
  ): Promise<{ bill: Record<string, unknown>; journalEntry: Record<string, unknown> }> {
    let vendorId = preReg.vendor_id as string | null;

    // ── EL ALTA DE PROVEEDOR ES UNA DECISIÓN, NO UN EFECTO COLATERAL.
    //
    // Aquí nacía una CONTRAPARTE con el nombre y el RFC que venían dentro de
    // un XML de un tercero, y en la misma llamada nacía el pasivo a su favor
    // y su póliza posteada. Nadie aprobaba nada: bastaba con que un CFDI
    // llegara —por la subida REST, por el agente, o porque una regla del
    // despacho puso processing_mode='auto'— para que el catálogo de
    // proveedores creciera solo. Un dato maestro que ningún humano miró es
    // exactamente lo que un control interno existe para impedir.
    //
    // Ahora el alta sólo ocurre si QUIEN LLAMA la autorizó. El default es no,
    // y el no es un rechazo que dice qué proveedor se iba a crear y cómo
    // seguir. La BÚSQUEDA por RFC se queda fuera de la puerta a propósito:
    // encontrar un proveedor que ya existe no crea nada, y es justo lo que
    // hace que «dalo de alta y vuelve a ejecutar» funcione.
    if (!vendorId && preReg.is_new_vendor && preReg.suggested_vendor_data) {
      const data = preReg.suggested_vendor_data as Record<string, unknown>;
      const vendorResult = await query<{ id: string }>(
        `SELECT id FROM vendors WHERE entity_id = $1 AND tax_id = $2 LIMIT 1`,
        [preReg.entity_id, data.tax_id]
      );
      if (vendorResult.rows.length > 0) {
        vendorId = vendorResult.rows[0].id;
      } else if (!opciones.permitirProveedorNuevo) {
        const texto = (v: unknown, alterno: string): string =>
          typeof v === 'string' && v.trim() ? v : alterno;
        throw new ProveedorNuevoSinAutorizar(
          texto(data.company_name, 'emisor sin nombre'),
          texto(data.tax_id, 'sin RFC')
        );
      } else {
        const newId = uuidv4();
        const vendorCount = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM vendors WHERE entity_id = $1`,
          [preReg.entity_id]
        );
        const year = new Date().getFullYear();
        const vendorNumber = `V-${year}-${(parseInt(vendorCount.rows[0].count, 10) + 1).toString().padStart(5, '0')}`;

        await query(
          `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
           VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
          [newId, preReg.entity_id, vendorNumber, data.company_name, data.tax_id, userId]
        );
        vendorId = newId;
      }
    }

    if (!vendorId) throw new ValidationError('Vendor is required to create a bill');

    const billId = uuidv4();
    const billCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM bills WHERE entity_id = $1`,
      [preReg.entity_id]
    );
    const year = new Date().getFullYear();
    const billNumber = `BILL-${year}-${(parseInt(billCount.rows[0].count, 10) + 1).toString().padStart(5, '0')}`;

    // Create bill
    await query(
      // El UUID fiscal viaja con el gasto desde su nacimiento (migración
      // 037). Antes sólo existía por el rodeo pre_registrations→xml_documents,
      // que muere con el pre-registro; la columna directa es la que hacen
      // baratos el DIOT, el amarre y la ligadura del REP.
      `INSERT INTO bills (
        id, entity_id, bill_number, vendor_id, vendor_invoice_number,
        subtotal, tax_amount, total_amount, amount_due,
        currency_code, exchange_rate, bill_date, due_date, status, created_by,
        cfdi_uuid
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'posted',$14,
        (SELECT cfdi_uuid FROM xml_documents WHERE id = $15))`,
      [
        billId, preReg.entity_id, billNumber, vendorId, preReg.external_reference,
        preReg.subtotal, preReg.tax_amount, preReg.total_amount, preReg.total_amount,
        preReg.currency_code, preReg.exchange_rate,
        preReg.document_date, preReg.due_date, userId,
        preReg.xml_document_id ?? null,
      ]
    );

    const lines = preReg.lines as LineWithSuggestion[];

    // Bill lines
    for (const line of lines) {
      const accountId = line.account_id || line.suggested_account_id || (preReg.default_account_id as string);
      if (!accountId) {
        throw new ValidationError(`Line ${line.line_number}: no account assigned`);
      }

      const taxAmt = line.impuestos?.traslados?.[0]?.importe || 0;

      await query(
        `INSERT INTO bill_lines (
          id, bill_id, line_number, account_id, description,
          quantity, unit_price, line_amount, tax_amount, total_amount
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv4(), billId, line.line_number, accountId, line.descripcion,
          line.cantidad, line.valor_unitario, line.importe, taxAmt,
          new Decimal(line.importe).plus(taxAmt).toFixed(4),
        ]
      );
    }

    // ── El asiento lo gobierna el clasificador fiscal.
    // Antes se armaba aquí a mano y TODO el IVA iba a la 1130 «IVA
    // Acreditable», sin mirar el método de pago. Bajo PPD el IVA no es
    // acreditable hasta que se paga la factura y llega el REP: cada
    // factura a crédito adelantaba un acreditamiento inexistente.
    const plan = await this.lineasDelAsiento(preReg, lines, billNumber);
    const jeLines = plan.lineas;
    // F02 · cfdi_periodo_cerrado='periodo_actual': la PÓLIZA va al periodo
    // abierto (fecha contable = hoy); la factura conserva su fecha fiscal.
    const fechaContable = plan.fechaContableHoy
      ? new Date()
      : new Date(preReg.document_date as string);

    const journalEntry = await createJournalEntry(
      preReg.entity_id as string,
      fechaContable,
      JournalEntryType.AUTO_INVOICE,
      `Bill ${billNumber} - ${preReg.external_reference}`,
      jeLines,
      userId,
      { sourceType: 'bill', sourceId: billId, autoPost: true }
    );

    // Link JE to bill
    await query(`UPDATE bills SET journal_entry_id = $1 WHERE id = $2`, [journalEntry.id, billId]);

    const billResult = await query('SELECT * FROM bills WHERE id = $1', [billId]);

    return {
      bill: billResult.rows[0],
      journalEntry: journalEntry as unknown as Record<string, unknown>,
    };
  }

  /**
   * Process batch
   */
  async processBatch(
    batchId: string,
    userId: string
  ): Promise<{ total: number; successful: number; failed: number; errors: Array<{ id: string; error: string }> }> {
    await query(
      `UPDATE processing_batches SET status = 'running', started_at = NOW(), executed_by = $1 WHERE id = $2`,
      [userId, batchId]
    );

    const preRegs = await query<Record<string, unknown>>(
      `SELECT * FROM pre_registrations
       WHERE scheduled_batch_id = $1 AND status = 'ready' AND processing_mode = 'batch'
       ORDER BY batch_priority ASC, created_at ASC`,
      [batchId]
    );

    const results = { total: preRegs.rows.length, successful: 0, failed: 0, errors: [] as Array<{ id: string; error: string }> };

    for (const preReg of preRegs.rows) {
      try {
        if (preReg.requires_approval && preReg.approval_status !== 'approved') {
          results.errors.push({ id: preReg.id as string, error: 'Requires approval' });
          results.failed++;
          continue;
        }
        // NUNCA crea proveedores. Un lote programado corre desatendido sobre
        // N documentos: quien pulsó «ejecutar» aprobó el lote, no el emisor de
        // cada comprobante que hay dentro. El que traiga proveedor nuevo se
        // queda en la bandeja con su motivo y no detiene a los demás.
        await this.processToAccounting(preReg, userId, { permitirProveedorNuevo: false });
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({ id: preReg.id as string, error: (error as Error).message });
      }
    }

    await query(
      `UPDATE processing_batches SET
        status = $2, completed_at = NOW(),
        total_items = $3, processed_items = $3,
        successful_items = $4, failed_items = $5,
        results_summary = $6::jsonb, error_log = $7::jsonb
       WHERE id = $1`,
      [
        batchId,
        results.failed > 0 ? 'completed_with_errors' : 'completed',
        results.total, results.successful, results.failed,
        JSON.stringify(results), JSON.stringify(results.errors),
      ]
    );

    return results;
  }
}

/** El vocabulario de xml_documents.sat_validation_status al del clasificador. */
function mapearEstadoSat(
  estado: string | null
): 'vigente' | 'cancelado' | 'no_encontrado' | 'sin_validar' {
  switch (estado) {
    case 'valid': return 'vigente';
    case 'cancelled': return 'cancelado';
    case 'not_found': return 'no_encontrado';
    default: return 'sin_validar';
  }
}

/**
 * Rol contable → id de cuenta, dentro de la entidad.
 *
 * El rol manda. El código heredado queda de red para las entidades sembradas
 * antes de que existiera la capa semántica, que todavía no han pasado por el
 * relleno de account_roles (E1.1).
 */
const CODIGO_HEREDADO: Partial<Record<AccountRole, string>> = {
  cxp: '2110',
  iva_acreditable: '1130',
  iva_pendiente_acreditar: '1135',
};

async function cuentasPorRol(
  cliente: pg.PoolClient,
  entityId: string,
  roles: AccountRole[]
): Promise<Map<string, string>> {
  const porRol = new Map<string, string>();

  const r = await cliente.query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
      WHERE entity_id = $1 AND qualifier IS NULL AND role = ANY($2::text[])`,
    [entityId, roles]
  );
  for (const fila of r.rows) porRol.set(fila.role, fila.account_id);

  const faltan = roles.filter((rol) => !porRol.has(rol));
  if (faltan.length === 0) return porRol;

  const codigos = faltan.map((rol) => CODIGO_HEREDADO[rol]).filter((c): c is string => !!c);
  if (codigos.length === 0) return porRol;

  const c = await cliente.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
    [entityId, codigos]
  );
  const porCodigo = new Map(c.rows.map((x) => [x.code, x.id]));
  for (const rol of faltan) {
    const id = porCodigo.get(CODIGO_HEREDADO[rol] as string);
    if (id) porRol.set(rol, id);
  }
  return porRol;
}
