/**
 * MNE-001-154 (#151), part 1: the AccountingError throws of
 * src/services/accounting that were written in Spanish prose are catalogue
 * keys now. The Spanish twin must print, byte for byte, what each site printed
 * before (the strings below are written by hand from those sites), and the
 * English is the source the error's `message` is fixed in.
 */
import { describe, expect, it } from 'vitest';
import { t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError } from '../../../src/utils/errors.js';

const SPANISH_AS_BEFORE: ReadonlyArray<readonly [TranslationKey, MessageParams, string]> = [
  // ar-ap-posting.ts
  ['error.MISSING_ROLE_ACCOUNT.unmapped', { role: 'cxc' },
    'No hay cuenta mapeada al rol "cxc" en esta entidad. Siembra la contabilidad con: mnemosine init --section identity (o revisa qué falta con: mnemosine doctor)'],
  ['error.FX_RATE_CONFLICT', { invoice: 'F-7', rate: '17.5', source: 'dof', published: '18.25', date: '2026-08-14' },
    "F-7 trae tipo de cambio 17.5 y la fuente 'dof' de la política fuente_tipo_cambio publicó 18.25 para 2026-08-14. No elijo uno en silencio: corrige el tipo de la factura o la política antes de emitirla."],
  ['error.INVOICE_ALREADY_POSTED', { invoice: 'F-7' },
    'F-7 ya tiene póliza o no es de esta entidad: no se enlaza otra.'],
  ['error.FX_RATE_MISSING.document', { bill: 'B-3', currency: 'USD', functional: 'MXN', rate: 'none' },
    'B-3 está en USD y los libros en MXN, pero su exchange_rate es nulo (el default de captura). Registra el tipo de cambio del documento antes de aprobarlo: sin él el pasivo se asentaría sin convertir y perdería su origen (NIF B-15).'],
  ['error.FX_RATE_MISSING.document', { bill: 'B-3', currency: 'USD', functional: 'MXN', rate: '1.0000' },
    'B-3 está en USD y los libros en MXN, pero su exchange_rate es 1.0000 (el default de captura). Registra el tipo de cambio del documento antes de aprobarlo: sin él el pasivo se asentaría sin convertir y perdería su origen (NIF B-15).'],
  ['error.FX_AR_ON_ACCOUNT_NOT_WIRED', { payment: 'C-9', amount: '40.0000', currency: 'USD' },
    'C-9 deja 40.0000 USD a cuenta del cliente: un saldo a cuenta en otra moneda todavía no se aplica ni se desaplica convertido.'],
  ['error.WRITE_OFF_ACCOUNT_UNRESOLVED', {},
    'Hay un pago corto que condona saldo y nadie dijo a qué cuenta va. La decide la política `pago_corto_residual`; postear sin ella dejaría el asiento descuadrado.'],
  // fiscal-calendar-service.ts
  ['error.REASON_REQUIRED', {}, 'Reabrir un periodo cerrado exige un motivo: queda en el rastro de auditoría.'],
  ['error.PERIOD_LOCKED', { period: '2026-03' },
    "2026-03 está 'locked': su información ya salió del sistema y no se reabre. La corrección va en el periodo abierto más próximo."],
  ['error.PERIOD_NOT_CLOSED', { period: '2026-03', status: 'open' },
    "2026-03 está 'open': esta operación es sólo para periodos cerrados."],
  ['error.INVALID_STATUS', { status: 'locked' }, "Sólo se restaura a 'soft_close' o 'hard_close'; se pidió 'locked'."],
  ['error.PERIOD_NOT_OPEN.restore', { period: 'p-1' }, 'No se pudo restaurar el periodo p-1: ya no estaba abierto.'],
  ['error.TENANT_NO_RESUELTO.period', { entity: 'e-1' }, 'No se pudo determinar el inquilino de e-1.'],
  // iva-cash-basis.ts
  ['error.IVA_ROLE_UNRESOLVED.no_line', { side: 'received', method: 'PPD' },
    'La taxonomía CFDI no define una línea de IVA para (received, PPD). Revisa CASES en src/services/xml-ingestion/cfdi-taxonomy.ts.'],
  ['error.MISSING_ROLE_ACCOUNT.no_semantic_layer', { entity: 'e-1' },
    'La entidad e-1 no tiene sembrada la capa semántica, así que no se puede saber cuánto IVA tiene aparcado: el pago liberaría cero y el impuesto se quedaría ahí. Siémbrala con: npm run backfill:account-roles -- --tenant <uuid> --aplicar'],
  // journal-entry-service.ts
  ['error.ALREADY_POSTED.preview', { entry: 'PD-4' }, 'PD-4 ya está aplicada: no hay delta que previsualizar.'],
  ['error.ENTRY_VOID.preview', { entry: 'PD-4' }, 'PD-4 está anulada y jamás se aplicará.'],
  ['error.ALREADY_POSTED.edit', { entry: 'PD-4' }, 'PD-4 ya está aplicada: una póliza en el mayor es inmutable.'],
  ['error.ENTRY_VOID.edit', { entry: 'PD-4' }, 'PD-4 está anulada.'],
  ['error.ENTRY_NOT_EDITABLE', { entry: 'PD-4', status: 'pending_approval' },
    'PD-4 está en pending_approval: solo un borrador se edita.'],
  ['error.OPENING_DRAFT_LOCKED', { entry: 'PD-4' },
    'PD-4 es la apertura cargada de la balanza: sus renglones y su fecha no se editan. Aplícala con `entry post`, o anúlala con `entry void` y vuelve a cargar la balanza.'],
  // moneda-origen.ts
  ['error.ENTITY_NOT_FOUND.functional_currency', { entity: 'e-1' },
    'No existe la entidad e-1: sin su moneda funcional no se puede convertir nada.'],
  ['error.FX_POLITICA_DESCONOCIDA.rate_source', { value: 'bce', known: 'dof, banxico' },
    'La política fuente_tipo_cambio vale "bce" y este lector solo entiende dof, banxico. Corrige la política en mnemosine pending.'],
  ['error.FX_RATE_MISSING.policy_source', { from: 'USD', to: 'MXN', source: 'dof', date: '2026-08-21', policy: 'dof' },
    "No hay tipo de cambio USD→MXN de la fuente 'dof' para 2026-08-21. Captúralo con: mnemosine fx rate set USD/MXN 2026-08-21 <tasa> --source dof — o descárgalo con: mnemosine fx rate download. No se toma otra fuente ni otra fecha en silencio: la política fuente_tipo_cambio (dof) es un criterio fiscal del despacho, no una preferencia de esta función."],
  // period-close.ts
  ['error.TENANT_NO_RESUELTO.close', { entity: 'e-1' },
    'No se pudo determinar el inquilino de la entidad e-1: el cierre no se registra sin rastro.'],
  ['error.CIERRE_YA_EMITIDO', { entries: 'CI-1, CI-2' },
    'El periodo ya emitió su cierre (CI-1, CI-2) y la política cierre_recierre_de_periodo_reabierto lo prohíbe volver a cerrar: corrígelo por reclasificación explícita, o cambia la política en mnemosine pending.'],
  ['error.RESULTADO_SIN_BARRER', { count: 2, detail: '4100 10.0000; 6100 -3.0000' },
    'El cierre no dejó el ejercicio en cero: 2 cuenta(s) de resultados conservan saldo (4100 10.0000; 6100 -3.0000). El cierre se revirtió entero y el periodo sigue abierto: un saldo que sobrevive al cierre siembra mal el ejercicio siguiente. Si el despacho prefiere que esto sólo avise, la política es severidad_resultado_sin_barrer.'],
  // posting.ts
  ['error.SOD_QUIEN_CREA_NO_POSTEA.apply', { reference: 'R-1' },
    'R-1: la política de segregación de funciones exige que quien aplica no sea quien lo preparó. Que otro usuario lo aplique, o ajusta la política segregacion_de_funciones en mnemosine pending.'],
  ['error.SOD_QUIEN_CREA_NO_POSTEA.post', { entry: 'PD-4' },
    'PD-4: la política de segregación de funciones exige que quien postea no sea quien creó el borrador. Que otro usuario corra entry post, o ajusta la política segregacion_de_funciones en mnemosine pending.'],
  ['error.ENTITY_NOT_FOUND.posting', { entity: 'e-1' }, 'La entidad e-1 no existe o no es visible.'],
  ['error.TENANT_NO_RESUELTO.entry', { entity: 'e-1' },
    'No se pudo determinar el inquilino de la entidad e-1: el asiento no se escribe sin rastro de auditoría.'],
];

describe('MNE-001-154 · the Spanish twin prints what each site printed before', () => {
  it.each(SPANISH_AS_BEFORE)('%s', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it('covers the 30 keys of the part, once each beyond the select case', () => {
    expect(new Set(SPANISH_AS_BEFORE.map(([key]) => key)).size).toBe(30);
  });
});

describe('MNE-001-154 · the English source', () => {
  it('reads the same facts in English, the select branch included', () => {
    expect(t('error.FX_RATE_MISSING.document', { bill: 'B-3', currency: 'USD', functional: 'MXN', rate: 'none' }, 'en')).toBe(
      'B-3 is in USD and the books in MXN, but its exchange_rate is null (the capture default). Record the document\'s exchange rate before approving it: without it the liability would be posted unconverted and lose its origin (NIF B-15).'
    );
    expect(t('error.TENANT_NO_RESUELTO.entry', { entity: 'e-1' }, 'en')).toBe(
      'The tenant of entity e-1 could not be determined: the entry is not written without an audit trail.'
    );
    expect(t('error.REASON_REQUIRED', {}, 'en')).toBe('Reopening a closed period requires a reason: it stays in the audit trail.');
  });
});

describe('MNE-001-154 · the sites throw by key', () => {
  it('reopening a closed period without a reason: the code, an English message, the Spanish when rendered', async () => {
    const { reopenClosedPeriod } = await import('../../../src/services/accounting/fiscal-calendar-service.js');
    const err = await reopenClosedPeriod('e-1', 'p-1', 'u-1', '  ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect(err).toMatchObject({
      code: 'REASON_REQUIRED',
      messageKey: { key: 'error.REASON_REQUIRED' },
      message: 'Reopening a closed period requires a reason: it stays in the audit trail.',
    });
    expect((err as AccountingError).localized('es')).toBe(
      'Reabrir un periodo cerrado exige un motivo: queda en el rastro de auditoría.'
    );
  });

  it('restoring a period to a status that is not a close: the status travels as a param', async () => {
    const { restorePeriodStatus } = await import('../../../src/services/accounting/fiscal-calendar-service.js');
    const err = await restorePeriodStatus('e-1', 'p-1', 'locked', 'u-1', 'r').catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'INVALID_STATUS',
      messageKey: { key: 'error.INVALID_STATUS', params: { status: 'locked' } },
    });
    expect((err as AccountingError).localized('es')).toBe(
      "Sólo se restaura a 'soft_close' o 'hard_close'; se pidió 'locked'."
    );
  });
});
