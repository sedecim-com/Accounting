import { createHash } from 'node:crypto';
import { query } from '../../database/connection.js';

// ============================================================
// EL ALMACÉN DE LA LLAVE DE IDEMPOTENCIA.
//
// El núcleo del CLI inyecta --idempotency-key en todo comando irreversible o
// externo, y hasta la 039 la bandera se aceptaba con un aviso de que nada
// deduplicaba sobre ella. Este módulo la vuelve verdadera, con un contrato
// deliberadamente estrecho:
//
//   · La llave sólo actúa si el operador la PASÓ. No se autogenera de la
//     carga: dos corridas legítimamente idénticas (cerrar el mismo periodo
//     tras reabrirlo, postear un asiento re-abierto) no deben deduplicarse
//     solas. El default de la bandera es «sin llave», no «hash del payload».
//
//   · La fila se graba DESPUÉS del acto. Protege el reintento de un comando
//     que YA terminó; un proceso muerto a la mitad no dejó llave y ahí la
//     defensa sigue siendo el estado del dominio (el asiento ya posteado se
//     rechaza solo). Reservar la llave antes bloquearía el reintento
//     legítimo tras un crash — exactamente cuando más se necesita.
//
//   · Misma llave + misma carga → se devuelve el resultado grabado y el
//     comando sale 0 (exit.ts: «an idempotency hit with an identical
//     result»). Misma llave + otra carga → ConflictoDeIdempotencia, que el
//     CLI mapea a salida 6 (CONFLICT).
// ============================================================

export class ConflictoDeIdempotencia extends Error {
  /** Duck-typed for el kernel del CLI: exitCodeFor mapea 409 → CONFLICT (6). */
  readonly statusCode = 409;
  constructor(scope: string, clave: string) {
    super(
      `La llave de idempotencia "${clave}" ya se usó en "${scope}" con una carga DISTINTA. ` +
        'Un reintento idéntico habría devuelto el resultado grabado; esto es un reuso de llave. ' +
        'Elige otra llave, o revisa qué ejecutó la primera.'
    );
    this.name = 'ConflictoDeIdempotencia';
  }
}

/** SHA-256 hex de la carga canónica del acto, para payload_hash. */
export function hashDeCarga(...partes: Array<string | number | boolean | null | undefined>): string {
  return createHash('sha256').update(partes.map((p) => String(p ?? '')).join('|')).digest('hex');
}

export interface ActoIdempotente<T> {
  /** true cuando la llave ya estaba consumada y `resultado` viene del almacén. */
  repetido: boolean;
  resultado: T;
}

/**
 * Ejecuta `fn` bajo la llave, si la hay.
 *
 * Sin `clave`, ejecuta y no toca el almacén. Con `clave`: un hit con el mismo
 * `payloadHash` devuelve el resultado grabado sin ejecutar; con otro hash
 * lanza ConflictoDeIdempotencia; sin hit ejecuta y graba. La carrera de dos
 * procesos con la misma llave nueva la decide la restricción única: el que
 * pierde el INSERT verifica el hash del ganador y trata su propia ejecución
 * como el resultado válido (ambos ejecutaron; el dominio ya arbitró).
 */
export async function conLlave<T extends Record<string, unknown>>(
  ctx: { tenantId: string; entityId?: string },
  acto: { scope: string; clave?: string; payloadHash: string },
  fn: () => Promise<T>
): Promise<ActoIdempotente<T>> {
  if (!acto.clave) return { repetido: false, resultado: await fn() };

  const previa = await query<{ payload_hash: string; resultado: T }>(
    `SELECT payload_hash, resultado FROM idempotency_keys
     WHERE tenant_id = $1 AND scope = $2 AND clave = $3`,
    [ctx.tenantId, acto.scope, acto.clave]
  );
  if (previa.rows.length > 0) {
    if (previa.rows[0].payload_hash !== acto.payloadHash) {
      throw new ConflictoDeIdempotencia(acto.scope, acto.clave);
    }
    return { repetido: true, resultado: previa.rows[0].resultado };
  }

  const resultado = await fn();
  const grabada = await query(
    `INSERT INTO idempotency_keys (tenant_id, entity_id, scope, clave, payload_hash, resultado)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT uq_idempotency_keys DO NOTHING`,
    [ctx.tenantId, ctx.entityId ?? null, acto.scope, acto.clave, acto.payloadHash, JSON.stringify(resultado)]
  );
  if (grabada.rowCount === 0) {
    // Otro proceso consumó la llave mientras ejecutábamos. Si su carga era
    // otra, el reuso se acusa igual; si era la misma, ambos ejecutaron y el
    // estado del dominio ya arbitró (p.ej. el segundo post se rechazó solo).
    const ganadora = await query<{ payload_hash: string }>(
      `SELECT payload_hash FROM idempotency_keys
       WHERE tenant_id = $1 AND scope = $2 AND clave = $3`,
      [ctx.tenantId, acto.scope, acto.clave]
    );
    if (ganadora.rows[0] && ganadora.rows[0].payload_hash !== acto.payloadHash) {
      throw new ConflictoDeIdempotencia(acto.scope, acto.clave);
    }
  }
  return { repetido: false, resultado };
}
