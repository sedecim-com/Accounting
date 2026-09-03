import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import Decimal from 'decimal.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerDiotCommand, TITULAR_NO_PRESENTADA } from '../../src/cli/diot-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';
import { LO_QUE_FALTA_CONFIRMAR } from '../../src/services/sat/diot/index.js';

// ============================================================
// F07c · LAS TRES HOJAS DE `diot`, CONTRA POSTGRES DE VERDAD
//
// La unitaria (tests/cli/diot-command.spec.ts) prueba el contrato de la
// terminal con un doble del motor: banderas, códigos de salida, formatos.
// Lo que NO puede probar es que el número que la terminal imprime sea el que
// el MAYOR movió — un doble que devuelve «160.0000» sólo reproduce la cadena
// que alguien escribió en el arnés.
//
// Aquí se siembra el gasto, se aprueba —lo que manda su IVA a la cuenta
// acreditable— y se corre `diot generate` con el motor de verdad, y se
// compara el total impreso contra el movimiento del mes de esa cuenta,
// leído del libro. Es el mismo amarre que f07c-la-diot-que-se-paga hace
// sobre el servicio, hecho una vez más EN LA SUPERFICIE: entre el servicio y
// stdout hay un renderizador, y un renderizador también puede mentir.
//
// Corre como superusuario y con la RLS inerte, como el resto de la suite: lo
// que se comprueba es la frontera del CÓDIGO.
// ============================================================

let f: Fixture;
let tmpRaiz: string;

const MES = 5;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

async function sembrarProveedor(nombre: string, rfc: string | null): Promise<string> {
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
       currency_code, created_by, tipo_tercero, tipo_operacion)
     VALUES ($1,$2,$3,$4,$5,'rfc','MXN',$6,'04','03')`,
    [vendorId, f.entityId, `V-${vendorId.slice(0, 8)}`, nombre, rfc, f.userId]
  );
  return vendorId;
}

/** Un gasto PUE aprobado: su IVA ya es acreditable en el mes de la factura. */
async function sembrarGastoPue(
  vendorId: string,
  importe: string,
  iva: string
): Promise<{ billId: string; numero: string }> {
  const total = new Decimal(importe).plus(iva);
  const billId = uuidv4();
  const numero = `BILL-${billId.slice(0, 8)}`;
  const fecha = fechaEnPeriodo(MES, 10);
  const cuentaGasto = await cuentaPorCodigo(f.entityId, '6100');

  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,'PUE')`,
    [
      billId, f.entityId, numero, vendorId, `CFDI-${billId.slice(0, 8)}`,
      new Decimal(importe).toFixed(4), new Decimal(iva).toFixed(4), total.toFixed(4),
      fecha, f.userId,
    ]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description,
       quantity, unit_price, line_amount, tax_amount, total_amount,
       tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Servicios',1,$4,$4,$5,$6,'16.00','tasa')`,
    [
      uuidv4(), billId, cuentaGasto,
      new Decimal(importe).toFixed(4), new Decimal(iva).toFixed(4), total.toFixed(4),
    ]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return { billId, numero };
}

/** Lo que el MAYOR movió a la cuenta de IVA acreditable en el mes. */
async function ivaAcreditableDelMes(): Promise<string> {
  const desde = `2026-${String(MES).padStart(2, '0')}-01`;
  const hasta = new Date(Date.UTC(2026, MES, 0)).toISOString().slice(0, 10);
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS s
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN account_roles ar ON ar.account_id = jel.account_id
                            AND ar.entity_id = $1 AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND ar.role = 'iva_acreditable'
        AND je.entry_date >= $2::date AND je.entry_date <= $3::date`,
    [f.entityId, desde, hasta]
  );
  return new Decimal(r.rows[0]?.s ?? '0').toFixed(4);
}

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Habla con la terminal de verdad y devuelve lo que escribió y con qué código. */
async function correr(argv: string[]) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerDiotCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
    });
    await p.parseAsync([
      'node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId,
    ]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

const PERIODO = ['--period', `2026-${String(MES).padStart(2, '0')}`];

beforeAll(async () => {
  tmpRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f07c-terminal-'));
  f = await crearInquilino('F07c DIOT en la terminal');
  await seedPolicies({ tenantId: f.tenantId });
  const v = await sembrarProveedor('Servicios del Golfo SA', 'SDG010101AA1');
  await sembrarGastoPue(v, '1000.0000', '160.0000');
}, 180_000);

afterAll(async () => {
  fs.rmSync(tmpRaiz, { recursive: true, force: true });
  await drainAttestations(2000);
  await closeDatabase();
});

describe('diot generate · lo que imprime la terminal es lo que movió el mayor', () => {
  it('el IVA acreditable pagado del recibo ES el movimiento del mes de la cuenta', async () => {
    const r = await correr(['diot', 'generate', ...PERIODO, '--json']);
    expect(r.exitCode, r.err).toBe(ExitCode.OK);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    const fila = sobre.rows[0];
    // La igualdad es LITERAL y de cadena a cadena: si el renderizador
    // redondeara, la trasladara a número o perdiera un decimal, esto lo dice.
    expect(fila.iva_acreditable_pagado).toBe(await ivaAcreditableDelMes());
    expect(fila.iva_acreditable_pagado).toBe('160.0000');
    expect(fila.terceros).toBe(1);
    expect(fila.presentada).toBe(false);
    expect(fila.entregable).toBe(true);
  });

  it('la ficha legible dice el mes, el RFC del contribuyente y que NO se presentó', async () => {
    const r = await correr(['diot', 'generate', ...PERIODO]);
    expect(r.exitCode, r.err).toBe(ExitCode.OK);
    expect(r.out).toMatch(/DIOT 05\/2026/);
    expect(r.out).toMatch(/IVA acreditable pagado en el mes\s+160\.00/);
    expect(r.err).toContain(TITULAR_NO_PRESENTADA);
  });

  it('las tres políticas de la DIOT viajan al recibo con su valor vigente', async () => {
    const r = await correr(['diot', 'generate', ...PERIODO, '--json']);
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    for (const clave of [
      'diot_tipo_operacion_por_omision',
      'diot_tercero_sin_rfc',
      'diot_iva_exento_y_base',
    ]) {
      expect(fila[`criterio_${clave}`], clave).toBeTruthy();
    }
  });

  it('un mes sin una sola operación pagada no inventa terceros y sigue saliendo 0', async () => {
    const r = await correr(['diot', 'generate', '--period', '2026-11', '--json']);
    expect(r.exitCode, r.err).toBe(ExitCode.OK);
    const fila = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(fila.terceros).toBe(0);
    expect(fila.iva_acreditable_pagado).toBe('0.0000');
  });
});

describe('diot check · las verificaciones contra el libro real', () => {
  it('un PUE aprobado y no pagado avisa, sale 0, y con --strict sale 4', async () => {
    // El motor lo dice y hay que dejarlo dicho: un gasto marcado PUE entra
    // COMPLETO en la DIOT del mes aunque no se le haya aplicado un peso,
    // porque su IVA fue acreditable al contabilizarlo. Es un aviso y no un
    // bloqueante —el asiento es legítimo—, pero es la señal de que el método
    // pudo capturarse mal, y entonces el IVA se acredita antes de tiempo.
    const r = await correr(['diot', 'check', ...PERIODO]);
    expect(r.exitCode, `${r.out}${r.err}`).toBe(ExitCode.OK);
    expect(r.out).toContain('DIOT-PUE-SIN-PAGO');
    expect(r.out).toMatch(/0 bloqueante\(s\), 1 aviso\(s\)/);

    // El contrato §4: un aviso sólo tumba la tubería si se pide.
    const estricto = await correr(['diot', 'check', ...PERIODO, '--strict']);
    expect(estricto.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('un proveedor sin RFC bloquea con la política del panel, y sale 4', async () => {
    const v = await sembrarProveedor('Fletes sin papeles', null);
    await sembrarGastoPue(v, '500.0000', '80.0000');
    const r = await correr(['diot', 'check', ...PERIODO, '--json']);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    const filas = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows;
    const sinRfc = filas.find((x) => x.codigo === 'DIOT-SIN-RFC');
    expect(sinRfc, JSON.stringify(filas)).toBeDefined();
    expect(sinRfc?.check).toBe('tercero-identificado');
    expect(sinRfc?.severity).toBe('blocking');
    // El mensaje NOMBRA al proveedor: es la promesa de la política.
    expect(String(sinRfc?.detalle)).toContain('Fletes sin papeles');
  });

  it('pedir sólo otra verificación deja ese bloqueante fuera, y entonces sale 0', async () => {
    const r = await correr([
      'diot', 'check', ...PERIODO, '--check', 'politica-en-catalogo',
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
  });
});

describe('diot export · el papel de trabajo que se escribe, y el lote que se niega', () => {
  it('escribe un papel de trabajo con el tercero y sus casillas', async () => {
    const destino = path.join(tmpRaiz, 'diot-202605.txt');
    const r = await correr(['diot', 'export', ...PERIODO, '-o', destino]);
    // Hay un proveedor sin RFC sembrado por la prueba anterior: el papel se
    // escribe igual —es la herramienta con la que eso se arregla— y el código
    // dice que hay algo que ver.
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    const texto = fs.readFileSync(destino, 'utf8');
    expect(texto.startsWith('# PAPEL DE TRABAJO DE LA DIOT')).toBe(true);
    expect(texto).toContain('ESTO NO ES EL ARCHIVO DE LA DECLARACIÓN');
    expect(texto).toContain('SDG010101AA1');
    expect(texto).toContain('LA DECLARACIÓN NO SE PUEDE ENTREGAR TAL CUAL');
  });

  it('los bytes son estables: dos exportaciones del mismo mes son idénticas', async () => {
    const a = path.join(tmpRaiz, 'a.txt');
    const b = path.join(tmpRaiz, 'b.txt');
    await correr(['diot', 'export', ...PERIODO, '-o', a]);
    await correr(['diot', 'export', ...PERIODO, '-o', b]);
    expect(fs.readFileSync(a)).toEqual(fs.readFileSync(b));
  });

  it('--layout sat NO inventa el archivo: se niega y enumera lo que falta', async () => {
    const r = await correr(['diot', 'export', '--period', '2026-11', '--layout', 'sat']);
    // Noviembre no tiene bloqueantes (no tiene nada), así que la negativa que
    // llega es la del LAYOUT y no la de entregabilidad: 11, no 4.
    expect(r.exitCode).toBe(ExitCode.NEEDS_HUMAN);
    const mensaje = (r.errs[0] as Error).message;
    for (const punto of LO_QUE_FALTA_CONFIRMAR) expect(mensaje).toContain(punto);
    expect(r.out).toBe('');
  });
});
