import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// F01 · ENTRY IMPORT — preparar el lote, jamás el mayor (045)
//
// Dos layouts REALES en el primer corte:
//   ndjson — una póliza por línea, la MISMA forma que `entry create
//            --file` (date, description?, reference?, lines[]).
//   csv    — una LÍNEA de póliza por renglón, agrupadas por clave:
//            entry_key,entry_date,description,account_code,debit,credit[,line_description]
//
// Los layouts propietarios (contpaqi, aspel, iif, sat-polizas) se
// RECHAZAN con mensaje: un parser de formato propietario sin fixtures
// reales es un generador de pólizas plausibles y falsas — cuando haya
// archivos de verdad, cada uno llega con su parser y sus pruebas.
//
// El parseo es TOLERANTE POR FILA y ESTRICTO EN EL REPORTE: la fila
// ilegible se queda en el lote con su parse_error; nada se descarta en
// silencio y el resumen dice cuántas no pasaron.
// ============================================================

export const IMPORT_LAYOUTS = ['csv', 'ndjson'] as const;
const LAYOUTS_PENDIENTES = ['contpaqi', 'aspel', 'iif', 'sat-polizas'];

export interface FilaImportada {
  row_number: number;
  payload: Record<string, unknown> | null;
  parse_error: string | null;
}

export interface LoteParseado {
  filas: FilaImportada[];
  validas: number;
  invalidas: number;
}

export function assertLayoutSoportado(layout: string): void {
  if ((IMPORT_LAYOUTS as readonly string[]).includes(layout)) return;
  if (LAYOUTS_PENDIENTES.includes(layout)) {
    throw new ValidationError(
      `El layout "${layout}" aún no está soportado (falta el parser con fixtures reales). Hoy: ${IMPORT_LAYOUTS.join(', ')}.`
    );
  }
  throw new ValidationError(`Layout desconocido "${layout}". Soportados: ${IMPORT_LAYOUTS.join(', ')}.`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validarPoliza(p: Record<string, unknown>): string | null {
  if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) return `fecha ilegible "${String(p.date)}"`;
  if (!Array.isArray(p.lines) || p.lines.length < 2) return 'una póliza necesita al menos dos líneas';
  for (const [i, l] of (p.lines as Record<string, unknown>[]).entries()) {
    if (!l.account || !String(l.account).trim()) return `línea ${i + 1}: sin código de cuenta`;
    const d = l.debit != null && l.debit !== '';
    const c = l.credit != null && l.credit !== '';
    if (d === c) return `línea ${i + 1}: exactamente un lado (debit o credit)`;
  }
  return null;
}

export function parseNdjson(contenido: string): LoteParseado {
  const filas: FilaImportada[] = [];
  const lineas = contenido.split(/\r?\n/);
  let n = 0;
  for (const cruda of lineas) {
    const linea = cruda.trim();
    if (linea === '') continue;
    n += 1;
    try {
      const payload = JSON.parse(linea) as Record<string, unknown>;
      filas.push({ row_number: n, payload, parse_error: validarPoliza(payload) });
    } catch (err) {
      filas.push({ row_number: n, payload: null, parse_error: `JSON ilegible: ${(err as Error).message}` });
    }
  }
  return resumen(filas);
}

export function parseCsvEntradas(contenido: string): LoteParseado {
  // entry_key,entry_date,description,account_code,debit,credit[,line_description]
  const lineas = contenido.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const grupos = new Map<string, { date: string; description: string; lines: Record<string, unknown>[]; errores: string[] }>();
  const orden: string[] = [];

  for (const [idx, cruda] of lineas.entries()) {
    const celdas = cruda.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (idx === 0 && /^entry_key/i.test(celdas[0])) continue;
    if (celdas.length < 6) continue;
    const [key, fecha, descripcion, cuenta, debit, credit, lineDesc] = celdas;
    if (!grupos.has(key)) {
      grupos.set(key, { date: fecha, description: descripcion, lines: [], errores: [] });
      orden.push(key);
    }
    const g = grupos.get(key)!;
    if (g.date !== fecha) g.errores.push(`fechas mezcladas en la clave ${key} (${g.date} vs ${fecha})`);
    g.lines.push({
      account: cuenta,
      debit: debit === '' ? null : debit,
      credit: credit === '' ? null : credit,
      description: lineDesc ?? '',
    });
  }

  const filas: FilaImportada[] = orden.map((key, i) => {
    const g = grupos.get(key)!;
    const payload = { entry_key: key, date: g.date, description: g.description, lines: g.lines };
    const error = g.errores[0] ?? validarPoliza(payload);
    return { row_number: i + 1, payload, parse_error: error };
  });
  return resumen(filas);
}

function resumen(filas: FilaImportada[]): LoteParseado {
  const invalidas = filas.filter((f) => f.parse_error !== null).length;
  return { filas, validas: filas.length - invalidas, invalidas };
}

export function parseImportFile(layout: string, contenido: string): LoteParseado {
  assertLayoutSoportado(layout);
  return layout === 'ndjson' ? parseNdjson(contenido) : parseCsvEntradas(contenido);
}

export interface LoteImportado {
  batchId: string;
  validas: number;
  invalidas: number;
}

export async function stageEntryImport(
  ctx: { tenantId: string; entityId: string },
  entrada: { layout: string; fileName: string; fileHash: string; lote: LoteParseado },
  createdBy: string
): Promise<LoteImportado> {
  if (entrada.lote.filas.length === 0) {
    throw new ValidationError('El archivo no trae una sola póliza legible: nada que preparar.');
  }
  const batchId = uuidv4();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO journal_entry_import_batches (
        id, tenant_id, entity_id, layout, file_name, file_hash,
        rows_total, rows_invalid, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        batchId, ctx.tenantId, ctx.entityId, entrada.layout, entrada.fileName,
        entrada.fileHash, entrada.lote.filas.length, entrada.lote.invalidas, createdBy,
      ]
    );
    for (const fila of entrada.lote.filas) {
      await client.query(
        `INSERT INTO journal_entry_import_rows (id, tenant_id, batch_id, row_number, payload, parse_error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), ctx.tenantId, batchId, fila.row_number,
         JSON.stringify(fila.payload ?? {}), fila.parse_error]
      );
    }
  });
  return { batchId, validas: entrada.lote.validas, invalidas: entrada.lote.invalidas };
}
