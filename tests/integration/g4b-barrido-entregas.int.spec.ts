import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createWebhook } from '../../src/services/webhooks/webhook-service.js';
import {
  barrerEntregasVencidas,
  ARRIENDO_SEGUNDOS,
} from '../../src/services/webhooks/barrido-entregas.js';
import { MUERTA_PREFIJO } from '../../src/services/webhooks/politica-reintento.js';
import { registerWebhookSweepCommand } from '../../src/cli/webhook-sweep-command.js';
import type { WebhookDelivery } from '../../src/types/index.js';

/**
 * G4b · LO QUE NO SE ENTREGÓ, SE REINTENTA.
 *
 * `webhook_deliveries` existe desde la 003 con `attempt_count`,
 * `next_retry_at` y hasta un índice parcial sobre esa columna; `markFailed`
 * llevaba años escribiéndola, y NADIE la leía. Estas pruebas ejercen el
 * barrido que la lee: que reintenta lo vencido y sólo lo vencido, que
 * retrocede exponencialmente, que declara muerta la entrega agotada y lo
 * dice, que manda la misma llave de evento en cada intento, y que cruzar
 * inquilinos no es mezclarlos.
 *
 * EL BORDE DE RED ES LO ÚNICO SIMULADO. La base es Postgres de verdad: el
 * reclamo, el arriendo, el retroceso, la muerte y la frontera se comprueban
 * sobre filas reales. `fetch` se sustituye porque el guardián SSRF
 * (url-guard.ts) rechaza —con razón— cualquier receptor en loopback, así que
 * un servidor local de prueba no llegaría nunca a llamarse. El host `.invalid`
 * no resuelve, `assertDestinoPublico` deja pasar por eso, y el sustituto
 * recibe la llamada.
 */

interface Llamada {
  url: string;
  webhookId: string;
  evento: string;
  firma: string;
  timestamp: string;
  cuerpo: string;
}

let a: Fixture;
let b: Fixture;
let llamadas: Llamada[] = [];
let responder: (url: string) => { ok: boolean; status: number };
const fetchReal = globalThis.fetch;

function instalarReceptor(): void {
  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const cuerpo = typeof init?.body === 'string' ? init.body : '';
    const h = new Headers(init?.headers);
    llamadas.push({
      url,
      webhookId: h.get('X-Webhook-ID') ?? '',
      evento: h.get('X-Webhook-Event') ?? '',
      firma: h.get('X-Webhook-Signature') ?? '',
      timestamp: h.get('X-Webhook-Timestamp') ?? '',
      cuerpo,
    });
    const r = responder(url);
    return new Response(r.ok ? 'ok' : 'boom', { status: r.status });
  }) as typeof globalThis.fetch;
}

/**
 * Una suscripción con su política propia. `retry_config` existe desde la 003
 * y hasta este frente no lo leía nadie: fijarlo aquí prueba de paso que ahora
 * manda, y permite matar una entrega en dos intentos en vez de en doce.
 */
async function suscripcion(
  f: Fixture,
  url: string,
  opciones: { maxIntentos?: number; baseSegundos?: number; activa?: boolean } = {}
): Promise<string> {
  const wh = await withTenant(f.tenantId, () => createWebhook(f.tenantId, url, ['invoice.paid']));
  await query(
    `UPDATE webhook_subscriptions
        SET retry_config = $2::jsonb, is_active = $3
      WHERE id = $1`,
    [
      wh.id,
      JSON.stringify({
        max_retries: opciones.maxIntentos ?? 3,
        retry_interval_seconds: opciones.baseSegundos ?? 60,
      }),
      opciones.activa ?? true,
    ]
  );
  return wh.id;
}

/** Una entrega YA VENCIDA: `pending` con la hora de reintento en el pasado. */
async function entregaVencida(
  webhookId: string,
  opciones: { intentos?: number; vencidaHace?: string; evento?: string } = {}
): Promise<string> {
  const id = uuidv4();
  const evento = opciones.evento ?? 'invoice.paid';
  const payload = {
    id: `whd_${id.substring(0, 8)}`,
    event: evento,
    timestamp: new Date().toISOString(),
    data: { invoice: 'F-001' },
  };
  await query(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, payload, status, attempt_count, next_retry_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, NOW() - $6::interval)`,
    [id, webhookId, evento, JSON.stringify(payload), opciones.intentos ?? 1, opciones.vencidaHace ?? '1 minute']
  );
  return id;
}

async function leer(id: string): Promise<WebhookDelivery> {
  const { rows } = await query<WebhookDelivery>('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
  return rows[0];
}

beforeAll(async () => {
  a = await crearInquilino('Barrido A');
  b = await crearInquilino('Barrido B');
});

afterAll(async () => {
  globalThis.fetch = fetchReal;
  await closeDatabase();
});

beforeEach(() => {
  llamadas = [];
  responder = () => ({ ok: false, status: 500 });
  instalarReceptor();
});

afterEach(() => {
  globalThis.fetch = fetchReal;
});

describe('el barrido lee el reloj que nadie miraba', () => {
  it('reintenta la vencida y NO toca la que aún tiene turno', async () => {
    const wh = await suscripcion(a, 'https://receptor-a.invalid/hook');
    const vencida = await entregaVencida(wh);

    const futura = uuidv4();
    await query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, next_retry_at)
       VALUES ($1, $2, 'invoice.paid', '{"id":"whd_futura"}'::jsonb, 'pending', 1, NOW() + interval '1 hour')`,
      [futura, wh]
    );

    const r = await barrerEntregasVencidas({ tenantId: a.tenantId });

    expect(r.vencidas).toBe(1);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].webhookId).toBe(vencida);
    // La que no había vencido sigue intacta: mismo intento, misma fecha.
    expect((await leer(futura)).attempt_count).toBe(1);
  });

  it('la entregada con 200 queda success, con su hora de entrega', async () => {
    responder = () => ({ ok: true, status: 200 });
    const wh = await suscripcion(a, 'https://receptor-ok.invalid/hook');
    const id = await entregaVencida(wh);

    const r = await barrerEntregasVencidas({ tenantId: a.tenantId });
    expect(r.entregadas).toBe(1);

    const fila = await leer(id);
    expect(fila.status).toBe('success');
    expect(fila.delivered_at).not.toBeNull();
    expect(fila.attempt_count).toBe(2);
  });

  it('la marcha seca enumera sin reclamar, sin entregar y sin escribir', async () => {
    const wh = await suscripcion(a, 'https://receptor-seco.invalid/hook');
    const id = await entregaVencida(wh);
    const antes = await leer(id);

    const r = await barrerEntregasVencidas({ tenantId: a.tenantId, marchaSeca: true });

    expect(r.vencidas).toBe(1);
    expect(llamadas).toHaveLength(0);
    const despues = await leer(id);
    expect(despues.attempt_count).toBe(antes.attempt_count);
    expect(new Date(despues.next_retry_at!).getTime()).toBe(new Date(antes.next_retry_at!).getTime());
  });
});

describe('retroceso exponencial y tope de intentos', () => {
  it('cada fallo empuja la espera más lejos que el anterior', async () => {
    // max_retries alto para que no muera antes de poder observar la curva.
    const wh = await suscripcion(a, 'https://receptor-curva.invalid/hook', { maxIntentos: 9 });
    const id = await entregaVencida(wh, { intentos: 1 });

    const esperas: number[] = [];
    for (let pasada = 0; pasada < 3; pasada++) {
      // Se vuelve a vencer a mano para no tener que esperar la espera real.
      await query(`UPDATE webhook_deliveries SET next_retry_at = NOW() - interval '1 second' WHERE id = $1`, [id]);
      const t0 = Date.now();
      await barrerEntregasVencidas({ tenantId: a.tenantId });
      const fila = await leer(id);
      expect(fila.status).toBe('pending');
      esperas.push((new Date(fila.next_retry_at!).getTime() - t0) / 1000);
    }

    // 2^(n-1) sobre base 60 s: ~120, ~240, ~480, con ±20 % de ruido. El
    // aserto es sobre el ORDEN y la banda, no sobre el valor exacto: el
    // ruido es deliberado (ver politica-reintento.ts) y una prueba que
    // exigiera el valor exacto estaría exigiendo que no lo hubiera.
    expect(esperas[0]).toBeGreaterThan(60);
    expect(esperas[0]).toBeLessThan(160);
    expect(esperas[1]).toBeGreaterThan(esperas[0]);
    expect(esperas[2]).toBeGreaterThan(esperas[1]);
    expect(esperas[2]).toBeLessThan(700);
  });

  it('al agotar los intentos la entrega se declara MUERTA, y lo dice en la fila', async () => {
    const wh = await suscripcion(a, 'https://receptor-muerte.invalid/hook', { maxIntentos: 3 });
    const id = await entregaVencida(wh, { intentos: 2 });

    const r = await barrerEntregasVencidas({ tenantId: a.tenantId });

    expect(r.muertas).toBe(1);
    expect(r.detalle[0].muerta).toBe(true);

    const fila = await leer(id);
    expect(fila.status).toBe('failed');
    expect(fila.attempt_count).toBe(3);
    // MUERTA = ('failed', next_retry_at NULL). El CHECK de la 003 no admite
    // un cuarto valor de status y las migraciones no se tocan en este frente.
    expect(fila.next_retry_at).toBeNull();
    expect(fila.error_message).toContain(MUERTA_PREFIJO);
    expect(fila.error_message).toContain('3 intento(s)');
  });

  it('la muerta ya no se vuelve a barrer: la cola no arde en silencio', async () => {
    const wh = await suscripcion(a, 'https://receptor-fin.invalid/hook', { maxIntentos: 2 });
    const id = await entregaVencida(wh, { intentos: 1 });

    await barrerEntregasVencidas({ tenantId: a.tenantId });
    expect((await leer(id)).status).toBe('failed');

    llamadas = [];
    const segunda = await barrerEntregasVencidas({ tenantId: a.tenantId });
    expect(segunda.vencidas).toBe(0);
    expect(llamadas).toHaveLength(0);
  });

  it('honra el retry_config de LA SUSCRIPCIÓN, que llevaba años sin lector', async () => {
    const duro = await suscripcion(a, 'https://receptor-duro.invalid/hook', { maxIntentos: 9 });
    const blando = await suscripcion(a, 'https://receptor-blando.invalid/hook', { maxIntentos: 2 });
    const idDuro = await entregaVencida(duro, { intentos: 1 });
    const idBlando = await entregaVencida(blando, { intentos: 1 });

    await barrerEntregasVencidas({ tenantId: a.tenantId });

    expect((await leer(idDuro)).status).toBe('pending');
    expect((await leer(idBlando)).status).toBe('failed');
  });
});

describe('idempotencia hacia fuera', () => {
  it('cada reintento manda la MISMA llave de evento; la firma es nueva', async () => {
    const wh = await suscripcion(a, 'https://receptor-idem.invalid/hook', { maxIntentos: 9 });
    const id = await entregaVencida(wh, { intentos: 1 });

    for (let i = 0; i < 2; i++) {
      await query(`UPDATE webhook_deliveries SET next_retry_at = NOW() - interval '1 second' WHERE id = $1`, [id]);
      await barrerEntregasVencidas({ tenantId: a.tenantId });
      // Un segundo entero entre intentos: el timestamp de la firma tiene
      // resolución de segundos, y sin esta pausa dos intentos del mismo
      // segundo producirían la misma firma por casualidad, no por diseño.
      await new Promise((r) => setTimeout(r, 1100));
    }

    expect(llamadas).toHaveLength(2);
    // La llave estable: es lo único que el receptor puede usar para
    // deduplicar, y es idéntica en los dos intentos.
    expect(llamadas[0].webhookId).toBe(id);
    expect(llamadas[1].webhookId).toBe(id);
    const cuerpo0 = JSON.parse(llamadas[0].cuerpo) as { id: string };
    const cuerpo1 = JSON.parse(llamadas[1].cuerpo) as { id: string };
    expect(cuerpo0.id).toBe(`whd_${id.substring(0, 8)}`);
    expect(cuerpo1.id).toBe(cuerpo0.id);
    expect(llamadas[1].cuerpo).toBe(llamadas[0].cuerpo);

    // La firma NO se repite, y es a propósito: cubre `t=<timestamp>.<cuerpo>`
    // para que el receptor pueda rechazar un replay por antigüedad. Repetirla
    // exigiría repetir el timestamp original, y un receptor con la ventana
    // habitual de cinco minutos rechazaría por viejo todo reintento posterior.
    expect(llamadas[1].timestamp).not.toBe(llamadas[0].timestamp);
    expect(llamadas[1].firma).not.toBe(llamadas[0].firma);
  });
});

describe('la frontera: cruza inquilinos sin mezclarlos', () => {
  it('barrer un inquilino no toca las entregas del otro', async () => {
    const whA = await suscripcion(a, 'https://receptor-frontera-a.invalid/hook', { maxIntentos: 9 });
    const whB = await suscripcion(b, 'https://receptor-frontera-b.invalid/hook', { maxIntentos: 9 });
    const idA = await entregaVencida(whA);
    const idB = await entregaVencida(whB);

    const r = await barrerEntregasVencidas({ tenantId: a.tenantId });

    expect(r.vencidas).toBe(1);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe('https://receptor-frontera-a.invalid/hook');
    expect((await leer(idA)).attempt_count).toBe(2);
    // La del otro inquilino no se tocó: ni intento, ni arriendo.
    expect((await leer(idB)).attempt_count).toBe(1);
  });

  it('el barrido de todos entrega cada evento a la URL de SU inquilino', async () => {
    const whA = await suscripcion(a, 'https://receptor-todos-a.invalid/hook', { maxIntentos: 9 });
    const whB = await suscripcion(b, 'https://receptor-todos-b.invalid/hook', { maxIntentos: 9 });
    const idA = await entregaVencida(whA, { evento: 'invoice.paid' });
    const idB = await entregaVencida(whB, { evento: 'invoice.paid' });

    await barrerEntregasVencidas({});

    const deA = llamadas.find((l) => l.webhookId === idA);
    const deB = llamadas.find((l) => l.webhookId === idB);
    expect(deA?.url).toBe('https://receptor-todos-a.invalid/hook');
    expect(deB?.url).toBe('https://receptor-todos-b.invalid/hook');
    // Y ninguna entrega salió por la URL del vecino.
    expect(llamadas.filter((l) => l.webhookId === idA && l.url.includes('-b.'))).toHaveLength(0);
    expect(llamadas.filter((l) => l.webhookId === idB && l.url.includes('-a.'))).toHaveLength(0);
  });

  it('el censo no usa BYPASSRLS: sólo lee ids de `tenants`, y el resto va con contexto', async () => {
    // La frontera está DENTRO del SQL además de en RLS, porque la suite corre
    // como superusuario y con RLS inerte una prueba que confiara sólo en la
    // política pasaría sin demostrar nada. Pedir el barrido de un inquilino
    // que no existe tiene que dar cero, no «todo».
    const wh = await suscripcion(a, 'https://receptor-censo.invalid/hook');
    await entregaVencida(wh);

    const r = await barrerEntregasVencidas({ tenantId: uuidv4() });
    expect(r.vencidas).toBe(0);
    expect(llamadas).toHaveLength(0);
  });
});

describe('el solape no entrega dos veces', () => {
  it('dos pasadas simultáneas se reparten la cola: nadie la manda dos veces', async () => {
    const wh = await suscripcion(a, 'https://receptor-solape.invalid/hook', { maxIntentos: 9 });
    const ids = [await entregaVencida(wh), await entregaVencida(wh), await entregaVencida(wh)];

    // El inquilino arrastra vencidas de pruebas anteriores de este archivo
    // (el caso del censo deja una a propósito). El reparto se cuenta contra
    // lo que había, no contra lo que esta prueba insertó.
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.webhook_id
        WHERE s.tenant_id = $1 AND s.is_active = true AND d.status = 'pending'
          AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= NOW()`,
      [a.tenantId]
    );
    const vencidasAntes = Number(rows[0].n);
    expect(vencidasAntes).toBeGreaterThanOrEqual(3);

    const [r1, r2] = await Promise.all([
      barrerEntregasVencidas({ tenantId: a.tenantId }),
      barrerEntregasVencidas({ tenantId: a.tenantId }),
    ]);

    // Entre las dos pasadas cada entrega se tomó UNA vez: el `FOR UPDATE
    // SKIP LOCKED` reparte, y el arriendo impide que la segunda pasada
    // reclame lo que la primera ya soltó. Ni una se quedó sin barrer ni una
    // se barrió dos veces.
    expect(r1.vencidas + r2.vencidas).toBe(vencidasAntes);
    for (const id of ids) {
      expect(llamadas.filter((l) => l.webhookId === id)).toHaveLength(1);
    }
  });

  it('la reclamada queda arrendada hacia adelante, no invisible', async () => {
    // Si el reclamo pusiera next_retry_at en NULL, un proceso muerto a mitad
    // de la pasada dejaría la entrega en `pending` sin fecha: invisible para
    // siempre para este mismo barrido. El arriendo sólo la retrasa.
    const wh = await suscripcion(a, 'https://receptor-arriendo.invalid/hook', { maxIntentos: 9 });
    const id = await entregaVencida(wh);
    responder = () => {
      throw new Error('el receptor no contesta');
    };

    const t0 = Date.now();
    await barrerEntregasVencidas({ tenantId: a.tenantId });
    const fila = await leer(id);

    expect(fila.status).toBe('pending');
    expect(fila.next_retry_at).not.toBeNull();
    // Tras el fallo manda la política, no el arriendo; en ambos casos hay
    // fecha futura y nunca NULL.
    const dentro = (new Date(fila.next_retry_at!).getTime() - t0) / 1000;
    expect(dentro).toBeGreaterThan(0);
    expect(dentro).toBeLessThanOrEqual(ARRIENDO_SEGUNDOS + 200);
  });
});

describe('la suscripción apagada se congela, no se mata', () => {
  it('ni se entrega ni se declara muerta, y el número se dice', async () => {
    const wh = await suscripcion(b, 'https://receptor-apagado.invalid/hook', { activa: false });
    const id = await entregaVencida(wh);

    const r = await barrerEntregasVencidas({ tenantId: b.tenantId });

    expect(r.congeladas).toBeGreaterThanOrEqual(1);
    expect(r.vencidas).toBe(0);
    expect(llamadas).toHaveLength(0);

    const fila = await leer(id);
    expect(fila.status).toBe('pending');
    expect(fila.attempt_count).toBe(1);
  });
});


/**
 * EL COMANDO, ENTERO, CONTRA LA BASE DE VERDAD.
 *
 * Las pruebas de arriba ejercen el servicio; ésta ejerce la hoja que lo
 * invoca —compuerta de `--live` incluida— sobre las mismas filas reales, para
 * que lo que se demuestra sea lo que un cron va a ejecutar y no una versión
 * del barrido que sólo existe dentro de la prueba.
 */
describe('mnemosine subscription delivery sweep, de punta a punta', () => {
  const identidad = (x: string): string => x;

  function correr(argv: string[]): Promise<{ salida: string[]; codigos: number[] }> {
    const salida: string[] = [];
    const codigos: number[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      salida.push(a.join(' '));
    });
    const program = new Command();
    program.exitOverride();
    const subscription = program.command('subscription').alias('suscripcion');
    registerWebhookSweepCommand(subscription, {
      palette: { dim: identidad, bold: identidad, yellow: identidad },
      shutdown: (async (code: number) => {
        codigos.push(code);
        return undefined as never;
      }) as (code: number) => Promise<never>,
      reportError: (e: unknown) => salida.push(`ERROR: ${(e as Error).message}`),
    });
    return program
      .parseAsync(argv, { from: 'user' })
      .then(() => {
        spy.mockRestore();
        return { salida, codigos };
      });
  }

  it('sin --live enumera y no manda nada; con --live entrega', async () => {
    responder = () => ({ ok: true, status: 200 });
    const wh = await suscripcion(a, 'https://receptor-cli.invalid/hook', { maxIntentos: 9 });
    const id = await entregaVencida(wh);

    const seco = await correr(['subscription', 'delivery', 'sweep', '-t', a.tenantId]);
    expect(seco.salida.join('\n')).toContain('sandbox: nothing was sent');
    expect(llamadas).toHaveLength(0);
    expect((await leer(id)).status).toBe('pending');

    const vivo = await correr(['subscription', 'delivery', 'sweep', '-t', a.tenantId, '--live']);
    expect(vivo.codigos).toEqual([0]);
    expect(llamadas.some((l) => l.webhookId === id)).toBe(true);
    expect((await leer(id)).status).toBe('success');
  });

  it('la salida JSON del barrido es la que un cron puede leer', async () => {
    const wh = await suscripcion(a, 'https://receptor-cli-json.invalid/hook', { maxIntentos: 2 });
    await entregaVencida(wh, { intentos: 1 });

    const { salida } = await correr([
      'subscription', 'delivery', 'sweep', '-t', a.tenantId, '--live', '--json',
    ]);
    const r = JSON.parse(salida.join('\n')) as {
      vencidas: number; muertas: number; detalle: Array<{ muerta: boolean; error: string | null }>;
    };
    expect(r.muertas).toBeGreaterThanOrEqual(1);
    const muerta = r.detalle.find((d) => d.muerta)!;
    expect(muerta.error).toContain(MUERTA_PREFIJO);
  });
});
