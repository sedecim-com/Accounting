import { describe, it, expect, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  conciliarFlujoDeEfectivo,
  movimientoRealDeEfectivo,
  cuentasDeEfectivo,
  type FlujoDerivado,
} from '../../src/services/reporting/cash-flow-reconcile.js';
import { registerCashFlowReconcile } from '../../src/cli/cashflow-reconcile-command.js';
import { palette } from '../../src/cli/palette.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G1b · EL AMARRE CONTRA EL EFECTIVO REAL
//
// El estado de flujos es el único estado financiero cuyo error es
// comprobable desde fuera: cualquiera lo compara contra su banco. Estas
// pruebas hacen exactamente eso — mueven dinero de verdad en el mayor y
// exigen que el residuo salga con su importe EXACTO, no «distinto de cero».
//
// Un amarre que sólo sabe decir «no cuadra» no sirve: el contador necesita
// la cifra para ir a buscarla. Por eso cada aserción es un `toBe` sobre el
// importe y no un `not.toBe('0.0000')`.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se ataca es
// la aritmética del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

const ENERO = { desde: '2026-01-01', hasta: '2026-01-31' };

afterAll(async () => {
  await drainAttestations(3000);
  // Deja constancia de que la suite tocó el mayor de verdad y no un doble:
  // va ANTES de cerrar el pool, que es lo último que puede pasar aquí.
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries WHERE status = 'posted'`
  );
  expect(Number(r.rows[0].n)).toBeGreaterThan(0);
  await closeDatabase();
});

async function asiento(
  f: Fixture,
  mes: number,
  dia: number,
  desc: string,
  cargo: string,
  abono: string,
  monto: string
) {
  return createJournalEntry(
    f.entityId,
    fechaEnPeriodo(mes, dia),
    JournalEntryType.STANDARD,
    desc,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: desc },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: desc },
    ],
    f.userId,
    { autoPost: true }
  );
}

/** Un estado derivado sintético: lo que el motor de `cashflow generate` publica. */
function derivado(operacion: string, inversion = '0.0000', financiamiento = '0.0000'): FlujoDerivado {
  return {
    method: 'indirecto',
    operating_activities: { total: operacion },
    investing_activities: { total: inversion },
    financing_activities: { total: financiamiento },
  };
}

// ============================================================
// 1 · QUÉ CUENTAS SON EFECTIVO
//
// El defecto que esto mata: la ruta REST clasificaba con `name ILIKE
// '%receivable%'` contra un catálogo sembrado en español. Aquí la
// clasificación es por el MAPA DE ROLES, y la trampa es que el rol `banco`
// apunta a 1110 «Caja y Bancos» —la cuenta de control— mientras el dinero se
// postea en 1111 y 1112, que cuelgan de ella.
// ============================================================

describe('las cuentas de efectivo salen del mapa de roles, no de los nombres', () => {
  it('incluye la cuenta del rol Y sus descendientes en el catálogo', async () => {
    const f = await crearInquilino('Efectivo por rol');
    enterTenant(f.tenantId);

    const cuentas = await cuentasDeEfectivo(f.entityId, 'rol');
    const porCodigo = new Map(cuentas.map((c) => [c.code, c]));

    expect(porCodigo.get('1110')?.via).toBe('rol');
    expect(porCodigo.get('1111')?.via).toBe('descendiente');
    expect(porCodigo.get('1112')?.via).toBe('descendiente');
    // Y NADA más: clientes (1120) es «Cuentas por Cobrar» y comparte padre
    // con 1110, así que un criterio por padre o por subtipo lo habría metido.
    expect(porCodigo.has('1120')).toBe(false);
    expect(porCodigo.has('1130')).toBe(false);
  });

  it('la cuenta bancaria atada FUERA del árbol del rol también es efectivo', async () => {
    const f = await crearInquilino('Efectivo por cuenta bancaria');
    enterTenant(f.tenantId);

    // El efectivo entra al mayor por DOS puertas: el rol `banco` y
    // `bank_accounts.gl_account_id`. La segunda la fija el usuario con
    // `bank account set`, y nada la obliga a colgar del árbol del rol —
    // aquí se ata a una cuenta hermana, fuera de 1110, que es el caso que
    // deja dinero invisible si sólo se abre una puerta.
    const gl = await query<{ id: string }>(
      `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id,
         normal_balance, created_by)
       VALUES (uuid_generate_v4(),'1190','Banco en el extranjero','asset','current_assets',$1,'debit',$2)
       RETURNING id`,
      [f.entityId, f.userId]
    );
    const glId = gl.rows[0].id;
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
         currency_code, account_type)
       VALUES (uuid_generate_v4(),$1,'Cuenta en el extranjero','Banco',$2,'MXN','checking')`,
      [f.entityId, glId]
    );

    const porCodigo = new Map(
      (await cuentasDeEfectivo(f.entityId, 'rol')).map((c) => [c.code, c])
    );
    expect(porCodigo.get('1190')?.via).toBe('cuenta_bancaria');
    // Y la puerta vieja sigue abierta: esto SUMA cuentas, no las sustituye.
    expect(porCodigo.get('1110')?.via).toBe('rol');
    expect(porCodigo.get('1111')?.via).toBe('descendiente');

    // Y su dinero CUENTA: sin esta rama el movimiento sería invisible para
    // el amarre y el residuo saldría inventado por los 7 000.
    await asiento(f, 1, 9, 'Depósito en el extranjero', glId, f.cuentas['3100'], '7000.0000');
    const m = await movimientoRealDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
    });
    expect(m.variacion).toBe('7000.0000');
  });

  it('el criterio «subtipo» no pierde la cuenta archivada a medio periodo', async () => {
    const f = await crearInquilino('Efectivo por subtipo');
    enterTenant(f.tenantId);

    // Dos cuentas marcadas como efectivo por SUBTIPO —el criterio que sirve
    // sobre un catálogo importado, que sí trae esos subtipos—, y una de
    // ellas archivada. El archivado es un hecho del catálogo de HOY; el
    // dinero que movió antes sigue estando en el mayor.
    const mk = async (code: string, nombre: string, activa: boolean) => {
      const r = await query<{ id: string }>(
        `INSERT INTO accounts (id, code, name, account_type, account_subtype, fs_category,
           entity_id, normal_balance, is_active, created_by)
         VALUES (uuid_generate_v4(),$1,$2,'asset','cash','current_assets',$3,'debit',$4,$5)
         RETURNING id`,
        [code, nombre, f.entityId, activa, f.userId]
      );
      return r.rows[0].id;
    };
    const viva = await mk('1191', 'Caja viva', true);
    const archivada = await mk('1192', 'Caja archivada', true);

    // Se postea con la cuenta VIVA y se archiva después: es el orden real, y
    // el único posible — el posteo rechaza una cuenta inactiva («Account
    // 1192 is inactive»), así que el dinero sólo puede entrar antes.
    await asiento(f, 1, 7, 'Depósito en caja viva', viva, f.cuentas['3100'], '2000.0000');
    await asiento(f, 1, 8, 'Depósito antes de archivar', archivada, f.cuentas['3100'], '900.0000');
    await query('UPDATE accounts SET is_active = false WHERE id = $1', [archivada]);

    const codigos = (await cuentasDeEfectivo(f.entityId, 'subtipo')).map((c) => c.code);
    expect(codigos).toContain('1191');
    // LA ARCHIVADA CUENTA. Dejarla fuera no quita su movimiento del mayor:
    // sólo quita el lado del amarre que lo explica, y fabrica un residuo.
    expect(codigos).toContain('1192');

    const m = await movimientoRealDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      criterio: 'subtipo',
    });
    expect(m.criterio).toBe('subtipo');
    expect(m.variacion).toBe('2900.0000');
  });

  it('el criterio «lista» se rehúsa nombrando la salida, en vez de caer al defecto', async () => {
    const f = await crearInquilino('Efectivo por lista');
    enterTenant(f.tenantId);
    await expect(cuentasDeEfectivo(f.entityId, 'lista')).rejects.toThrow(/lista/i);
  });
});

// ============================================================
// 2 · EL MOVIMIENTO REAL, DEL MAYOR
//
// El saldo inicial NO se lee de `account_balances.beginning_balance`: esa
// columna sólo la siembra el cierre duro, y una entidad que nunca corrió
// `close --hard` la tiene en cero — el amarre saldría perfecto por no tener
// contra qué fallar. Se acumula del libro.
// ============================================================

describe('la variación real de caja y bancos', () => {
  it('acumula el saldo inicial de lo posteado ANTES del periodo, sin cierre duro de por medio', async () => {
    const f = await crearInquilino('Variación real');
    enterTenant(f.tenantId);

    // Diciembre del año anterior no existe en el ejercicio 2026; el arranque
    // se hace dentro del propio 2026 pero fuera de enero.
    await asiento(f, 1, 5, 'Cobro de enero', f.cuentas['1111'], f.cuentas['1120'], '5000.0000');
    await asiento(f, 1, 20, 'Renta de enero', f.cuentas['6120'], f.cuentas['1111'], '1200.0000');
    await asiento(f, 2, 10, 'Cobro de febrero', f.cuentas['1111'], f.cuentas['1120'], '900.0000');

    const enero = await movimientoRealDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
    });
    expect(enero.criterio).toBe('rol');
    expect(enero.criterio_definido).toBe(false); // el defecto del catálogo
    expect(enero.saldo_inicial).toBe('0.0000');
    expect(enero.variacion).toBe('3800.0000');
    expect(enero.saldo_final).toBe('3800.0000');

    const febrero = await movimientoRealDeEfectivo(f.entityId, {
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    // Febrero HEREDA los 3 800 de enero como saldo inicial aunque nadie haya
    // cerrado nada: es el acumulado del mayor, no el arrastre del cierre.
    expect(febrero.saldo_inicial).toBe('3800.0000');
    expect(febrero.variacion).toBe('900.0000');
    expect(febrero.saldo_final).toBe('4700.0000');
  });

  it('no cuenta borradores: sólo el mayor posteado es efectivo', async () => {
    const f = await crearInquilino('Variación sin borradores');
    enterTenant(f.tenantId);

    await asiento(f, 1, 5, 'Cobro posteado', f.cuentas['1111'], f.cuentas['1120'], '2000.0000');
    await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(1, 6),
      JournalEntryType.STANDARD,
      'Cobro en borrador',
      [
        { account_id: f.cuentas['1111'], debit_amount: '7777.0000', credit_amount: null, description: 'Borrador' },
        { account_id: f.cuentas['1120'], debit_amount: null, credit_amount: '7777.0000', description: 'Borrador' },
      ],
      f.userId
      // sin autoPost: se queda en draft
    );

    const m = await movimientoRealDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
    });
    expect(m.variacion).toBe('2000.0000');
  });

  it('la frontera de entidad vive dentro del SQL: la hermana no aporta un peso', async () => {
    const padre = await crearInquilino('Amarre padre');
    enterTenant(padre.tenantId);
    const hermana = await crearEntidadHermana(padre, 'Amarre hermana');

    await asiento(padre, 1, 5, 'Cobro del padre', padre.cuentas['1111'], padre.cuentas['1120'], '1000.0000');
    await asiento(hermana, 1, 5, 'Cobro de la hermana', hermana.cuentas['1111'], hermana.cuentas['1120'], '4000.0000');

    const dePadre = await movimientoRealDeEfectivo(padre.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
    });
    const deHermana = await movimientoRealDeEfectivo(hermana.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
    });
    expect(dePadre.variacion).toBe('1000.0000');
    expect(deHermana.variacion).toBe('4000.0000');
    // Y las cuentas de efectivo tampoco se cruzan, aunque compartan código.
    const idsPadre = new Set((await cuentasDeEfectivo(padre.entityId, 'rol')).map((c) => c.account_id));
    for (const c of await cuentasDeEfectivo(hermana.entityId, 'rol')) {
      expect(idsPadre.has(c.account_id)).toBe(false);
    }
  });
});

// ============================================================
// 3 · EL CONTRASTE: UN PERIODO QUE AMARRA Y OTRO QUE NO
// ============================================================

describe('el estado de flujos contra el movimiento real', () => {
  it('cuadra: residuo 0.0000 y nada que avisar', async () => {
    const f = await crearInquilino('Amarre que cuadra');
    enterTenant(f.tenantId);

    // Un enero honesto: cobra 5 000 de clientes y paga 1 200 de renta.
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '5000.0000');
    await asiento(f, 1, 20, 'Renta', f.cuentas['6120'], f.cuentas['1111'], '1200.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('3800.0000'),
    });

    expect(c.residuo.real).toBe('3800.0000');
    expect(c.residuo.derivado).toBe('3800.0000');
    expect(c.residuo.importe).toBe('0.0000');
    expect(c.residuo.cuadra).toBe(true);
    expect(c.trato).toBe('sin_residuo');
    expect(c.aviso).toBeNull();
    expect(c.hallazgos).toEqual({ blocking: 0, warning: 0 });
  });

  it('NO cuadra a propósito: el residuo sale con su importe exacto y no se absorbe', async () => {
    const f = await crearInquilino('Amarre que descuadra');
    enterTenant(f.tenantId);

    // La aportación de capital ENTRA al banco. El financiamiento del estado
    // está clavado en '0.0000' (el defecto 2 que este tramo denuncia), así
    // que el estado afirma 3 800 y el banco se movió 53 800.
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '5000.0000');
    await asiento(f, 1, 20, 'Renta', f.cuentas['6120'], f.cuentas['1111'], '1200.0000');
    await asiento(f, 1, 25, 'Aportación de capital', f.cuentas['1111'], f.cuentas['3100'], '50000.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('3800.0000', '0.0000', '0.0000'),
    });

    expect(c.residuo.derivado).toBe('3800.0000');
    expect(c.residuo.real).toBe('53800.0000');
    expect(c.residuo.importe).toBe('-50000.0000');
    expect(c.residuo.cuadra).toBe(false);
    expect(c.trato).toBe('nombrado');
    expect(c.hallazgos).toEqual({ blocking: 0, warning: 1 });
    // EL RESIDUO SE NOMBRA Y SE CUANTIFICA. Si el aviso no trae la cifra, el
    // contador no tiene qué ir a buscar.
    expect(c.aviso).toContain('-50000.0000');
    expect(c.aviso).toContain('53800.0000');

    // Y NINGÚN renglón del estado lo absorbió: los tres totales que entraron
    // son los tres que salen del contraste.
    expect(c.residuo.derivado).toBe('3800.0000');
  });

  it('el residuo del otro signo: el estado afirma efectivo que nunca llegó', async () => {
    const f = await crearInquilino('Amarre inflado');
    enterTenant(f.tenantId);
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '1000.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('9000.0000'),
    });
    expect(c.residuo.importe).toBe('8000.0000');
    expect(c.aviso).toContain('8000.0000');
  });
});

// ============================================================
// 4 · LA POLÍTICA `flujo_efectivo_descuadre`
// ============================================================

describe('qué hace el panel con el descuadre', () => {
  /**
   * Deja la decisión RESUELTA en `policy_decisions`, que es la fila que
   * `getPolicy` consume.
   *
   * Se escribe la fila en vez de pasar por `seedPolicies` + `resolvePolicy`
   * a propósito: la siembra prueba el CATÁLOGO, y lo que aquí está bajo
   * prueba es el LECTOR — que la respuesta del despacho cambie lo que la
   * conciliación hace con el residuo. Atar esta prueba a la siembra la haría
   * fallar por un motivo que no es el suyo.
   */
  async function fijarPolitica(f: Fixture, key: string, valor: string) {
    await query(
      `INSERT INTO policy_decisions (
         tenant_id, entity_id, key, category, question, impact, options,
         default_value, status, resolved_value, resolved_by, resolved_at, source
       ) VALUES ($1, NULL, $2, 'contable', $3, $3, '[]'::jsonb,
                 'avisar', 'resolved', $4, $5, NOW(), 'prueba')`,
      [f.tenantId, key, `decision de prueba: ${key}`, valor, f.userId]
    );
  }

  async function conDescuadre(nombre: string, valor: string) {
    const f = await crearInquilino(nombre);
    enterTenant(f.tenantId);
    await fijarPolitica(f, 'flujo_efectivo_descuadre', valor);
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '1000.0000');
    return conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('0.0000'),
    });
  }

  it('«bloquear» convierte el residuo en hallazgo bloqueante', async () => {
    const c = await conDescuadre('Descuadre bloquear', 'bloquear');
    expect(c.politica_descuadre).toBe('bloquear');
    expect(c.politica_descuadre_definida).toBe(true);
    expect(c.trato).toBe('bloqueado');
    expect(c.hallazgos).toEqual({ blocking: 1, warning: 0 });
    expect(c.residuo.importe).toBe('-1000.0000');
  });

  it('«silencio» NO silencia la conciliación: la degrada a advertencia y lo dice', async () => {
    const c = await conDescuadre('Descuadre silencio', 'silencio');
    expect(c.trato).toBe('silenciado');
    expect(c.hallazgos).toEqual({ blocking: 0, warning: 1 });
    // La cifra sigue ahí: `reconcile` es el acto de PREGUNTAR por la
    // diferencia, y apagarlo sería apagar el instrumento que la caza.
    expect(c.residuo.importe).toBe('-1000.0000');
    expect(c.aviso).toContain('SIN mencionar');
  });

  it('sin responder el panel se aplica «avisar», el defecto del catálogo', async () => {
    const f = await crearInquilino('Descuadre por omisión');
    enterTenant(f.tenantId);
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '1000.0000');
    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('0.0000'),
    });
    expect(c.politica_descuadre).toBe('avisar');
    expect(c.politica_descuadre_definida).toBe(false);
    expect(c.trato).toBe('nombrado');
  });
});

// ============================================================
// 5 · LOS SOSPECHOSOS
//
// Una LISTA DE SOSPECHOSOS, no un veredicto. Lo que se exige aquí es que el
// movimiento que efectivamente explica el residuo APAREZCA, con su importe,
// y que las pólizas normales del periodo no lo ensucien.
// ============================================================

describe('--show-candidates: quién pudo dejar el residuo', () => {
  it('caza la aportación de capital que el financiamiento clavado en cero nunca vio', async () => {
    const f = await crearInquilino('Sospechosos capital');
    enterTenant(f.tenantId);

    await asiento(f, 1, 5, 'Cobro a cliente', f.cuentas['1111'], f.cuentas['1120'], '5000.0000');
    await asiento(f, 1, 20, 'Renta', f.cuentas['6120'], f.cuentas['1111'], '1200.0000');
    await asiento(f, 1, 25, 'Aportación de capital', f.cuentas['1111'], f.cuentas['3100'], '50000.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('3800.0000'),
      candidatos: 10,
    });

    expect(c.candidatos).toBeDefined();
    const capital = c.candidatos!.find((s) => s.counterpart_code === '3100');
    expect(capital).toBeDefined();
    expect(capital!.efecto_en_efectivo).toBe('50000.0000');
    expect(capital!.categoria_probable).toBe('financiamiento');
    expect(capital!.motivo).toBe('sin_reclamar');
    expect(capital!.description).toBe('Aportación de capital');
    // LA FECHA NO SE DESPLAZA AL LEERSE. Lo que se exige es que el
    // sospechoso traiga la fecha que el MAYOR guarda, carácter por carácter,
    // y por eso se contrasta contra el libro en vez de contra un literal.
    //
    // El literal sería una prueba peor y además frágil: `fechaEnPeriodo`
    // arma un Date en medianoche UTC y `pg` lo serializa en hora LOCAL, así
    // que en un huso negativo el asiento «del 25» se guarda como del 24
    // — de verdad, en la base. Fijar '2026-01-25' aquí no defendería el
    // amarre; ataría esta prueba al huso de la máquina que la corre, que es
    // justo el defecto que esta rama vino a matar. Lo que este módulo
    // controla es el camino de LECTURA, y eso es lo que se afirma.
    const guardada = await query<{ d: string }>(
      `SELECT entry_date::text AS d FROM journal_entries
        WHERE entity_id = $1 AND description = 'Aportación de capital'`,
      [f.entityId]
    );
    expect(capital!.entry_date).toBe(guardada.rows[0].d);
    // Y es una fecha en texto ISO, no un Date que pueda correrse después.
    expect(capital!.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // LA COBERTURA: la aportación explica los 50 000 del residuo, y no queda
    // nada más. Es lo que convierte la lista en una pista.
    expect(c.cobertura).toEqual({ explicado: '-50000.0000', sin_explicar: '0.0000' });

    // La renta y el cobro a clientes SÍ los reclama alguna sección
    // (resultados y capital de trabajo): no son sospechosos.
    const codigos = c.candidatos!.map((s) => s.counterpart_code);
    expect(codigos).not.toContain('6120');
    expect(codigos).not.toContain('1120');
  });

  it('reparte el efecto entre las contrapartidas de una póliza de varias líneas', async () => {
    const f = await crearInquilino('Sospechosos prorrateo');
    enterTenant(f.tenantId);

    // Una salida de banco de 3 000 contra DOS contrapartidas desiguales.
    // Atribuirle los 3 000 enteros a cada una daría 6 000 de sospecha por
    // una salida de 3 000 — y el contador saldría a buscar el doble.
    await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(1, 15),
      JournalEntryType.STANDARD,
      'Amortización de préstamo con intereses',
      [
        { account_id: f.cuentas['3100'], debit_amount: '2000.0000', credit_amount: null, description: 'Capital' },
        { account_id: f.cuentas['3300'], debit_amount: '1000.0000', credit_amount: null, description: 'Resultado' },
        { account_id: f.cuentas['1111'], debit_amount: null, credit_amount: '3000.0000', description: 'Salida de banco' },
      ],
      f.userId,
      { autoPost: true }
    );

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('0.0000'),
      candidatos: 10,
    });

    const porCodigo = new Map(c.candidatos!.map((s) => [s.counterpart_code, s]));
    expect(porCodigo.get('3100')?.efecto_en_efectivo).toBe('-2000.0000');
    expect(porCodigo.get('3300')?.efecto_en_efectivo).toBe('-1000.0000');
    expect(c.residuo.importe).toBe('3000.0000');
    expect(c.cobertura).toEqual({ explicado: '3000.0000', sin_explicar: '0.0000' });
  });

  it('dice cuánto NO explican: una cobertura parcial no se lee como completa', async () => {
    const f = await crearInquilino('Sospechosos cobertura parcial');
    enterTenant(f.tenantId);

    // Dos entradas de efectivo que el estado no cuenta, pero sólo UNA cae en
    // una categoría que la lista reclama: 2110 tiene el rol `cxp`, así que
    // pasa por capital de trabajo y no es sospechosa. El contador tiene que
    // enterarse de que quedan 15 000 sin explicar.
    await asiento(f, 1, 25, 'Aportación de capital', f.cuentas['1111'], f.cuentas['3100'], '50000.0000');
    await asiento(f, 1, 28, 'Proveedor que financia', f.cuentas['1111'], f.cuentas['2110'], '15000.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('0.0000'),
      candidatos: 10,
    });

    expect(c.residuo.importe).toBe('-65000.0000');
    expect(c.candidatos!.map((s) => s.counterpart_code)).toEqual(['3100']);
    expect(c.cobertura).toEqual({ explicado: '-50000.0000', sin_explicar: '-15000.0000' });
  });

  it('sin residuo no hay sospechosos: una lista de pólizas normales no es un hallazgo', async () => {
    const f = await crearInquilino('Sospechosos sin residuo');
    enterTenant(f.tenantId);
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '1000.0000');

    const c = await conciliarFlujoDeEfectivo(f.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('1000.0000'),
      candidatos: 10,
    });
    expect(c.residuo.cuadra).toBe(true);
    expect(c.candidatos).toBeUndefined();
  });

  it('los sospechosos tampoco cruzan la frontera de entidad', async () => {
    const padre = await crearInquilino('Sospechosos padre');
    enterTenant(padre.tenantId);
    const hermana = await crearEntidadHermana(padre, 'Sospechosos hermana');

    await asiento(hermana, 1, 25, 'Capital de la hermana', hermana.cuentas['1111'], hermana.cuentas['3100'], '90000.0000');
    await asiento(padre, 1, 25, 'Capital del padre', padre.cuentas['1111'], padre.cuentas['3100'], '7000.0000');

    const c = await conciliarFlujoDeEfectivo(padre.entityId, {
      startDate: ENERO.desde,
      endDate: ENERO.hasta,
      derivado: derivado('0.0000'),
      candidatos: 10,
    });
    expect(c.residuo.importe).toBe('-7000.0000');
    for (const s of c.candidatos ?? []) {
      expect(s.efecto_en_efectivo).not.toBe('90000.0000');
    }
  });
});

// ============================================================
// 6 · EL PERIODO INVERTIDO
// ============================================================

describe('el rango', () => {
  it('un periodo que termina antes de empezar se rehúsa', async () => {
    const f = await crearInquilino('Rango invertido');
    enterTenant(f.tenantId);
    await expect(
      conciliarFlujoDeEfectivo(f.entityId, {
        startDate: '2026-03-31',
        endDate: '2026-03-01',
        derivado: derivado('0.0000'),
      })
    ).rejects.toThrow(/antes de empezar/);
  });
});

// ============================================================
// 7 · EL COMANDO, DE VERDAD
//
// Todo lo anterior mide el motor. Esto mide LA PUERTA: el comando de
// commander tal como se registra, contra el mismo Postgres, con su contrato
// de códigos de salida. Un motor correcto detrás de una puerta que sale 0
// cuando debía salir 4 es un instrumento que miente en CI.
// ============================================================

describe('mnemosine cashflow reconcile · la puerta', () => {
  async function correr(
    f: Fixture,
    derivadoDelEstado: FlujoDerivado,
    argv: string[]
  ): Promise<{ code: number; out: string; err: string }> {
    const program = new Command('mnemosine');
    const cashflow = program.command('cashflow').alias('flujo').description('Statement of cash flows');
    let code = -1;
    const out: string[] = [];
    const err: string[] = [];
    const escribir = (destino: string[]) =>
      ((chunk: unknown) => {
        destino.push(String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(escribir(out));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(escribir(err));
    try {
      registerCashFlowReconcile(cashflow, {
        palette: palette(process.stdout),
        shutdown: (c: number) => {
          code = c;
        },
        reportError: (e: unknown) => {
          err.push(`${(e as Error).message}\n`);
        },
        construirEstado: async () => derivadoDelEstado,
      });
      // --tenant explícito: el binario real lo declara en la raíz y aquí no
      // hay raíz, y sin él `bootstrapTenant` hereda el contexto que dejó el
      // fixture anterior — que es otro inquilino.
      await program.parseAsync(
        [
          'node', 'mnemosine', 'cashflow', 'reconcile',
          '--tenant', f.tenantId, '--entity', f.entityId, ...argv,
        ],
        { from: 'node' }
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return { code, out: out.join(''), err: err.join('') };
  }

  it('sale 0 y dice que amarra cuando amarra', async () => {
    const f = await crearInquilino('Puerta que amarra');
    enterTenant(f.tenantId);
    await asiento(f, 1, 5, 'Cobro', f.cuentas['1111'], f.cuentas['1120'], '2500.0000');

    const r = await correr(f, derivado('2500.0000'), ['--period', '2026-01', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out) as { rows: Array<{ line: string; amount: string }> };
    const residuo = payload.rows.find((x) => x.line === 'residuo');
    expect(residuo?.amount).toBe('0.0000');
    expect(r.err).toContain('Amarra');
  });

  it('con residuo sale 0 por omisión y 4 con --strict, y la cifra sale en las dos', async () => {
    const f = await crearInquilino('Puerta con residuo');
    enterTenant(f.tenantId);
    await asiento(f, 1, 25, 'Aportación de capital', f.cuentas['1111'], f.cuentas['3100'], '40000.0000');

    const suave = await correr(f, derivado('0.0000'), ['--period', '2026-01', '--json']);
    expect(suave.code).toBe(0);
    expect(suave.err).toContain('-40000.0000');

    const duro = await correr(f, derivado('0.0000'), ['--period', '2026-01', '--json', '--strict']);
    expect(duro.code).toBe(4);
    expect(duro.err).toContain('-40000.0000');
  });

  it('--show-candidates trae al sospechoso en la MISMA tabla, marcado como tal', async () => {
    const f = await crearInquilino('Puerta con sospechosos');
    enterTenant(f.tenantId);
    await asiento(f, 1, 25, 'Aportación de capital', f.cuentas['1111'], f.cuentas['3100'], '40000.0000');

    const r = await correr(f, derivado('0.0000'), [
      '--period', '2026-01', '--json', '--show-candidates',
    ]);
    const payload = JSON.parse(r.out) as {
      rows: Array<{ line: string; amount: string; counterpart_code: string; reason: string }>;
    };
    const sospechoso = payload.rows.find((x) => x.line === 'sospechoso');
    expect(sospechoso?.counterpart_code).toBe('3100');
    expect(sospechoso?.amount).toBe('40000.0000');
    expect(sospechoso?.reason).toBe('sin_reclamar');
    // Un solo encabezado: contraste y sospechosos viajan en la misma tabla.
    expect(payload.rows.filter((x) => x.line === 'residuo')).toHaveLength(1);
    expect(r.err).toContain('LISTA DE SOSPECHOSOS');
  });

  it('sin rango se rehúsa con código de uso (2), no inventa el mes en curso', async () => {
    const f = await crearInquilino('Puerta sin rango');
    enterTenant(f.tenantId);
    const r = await correr(f, derivado('0.0000'), ['--json']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/period/i);
  });
});
