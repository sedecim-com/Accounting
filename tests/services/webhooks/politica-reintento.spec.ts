import { describe, it, expect } from 'vitest';
import {
  politicaDe,
  veredicto,
  razonDeMuerte,
  MUERTA_PREFIJO,
  TOPE_ESPERA_SEGUNDOS,
} from '../../../src/services/webhooks/politica-reintento.js';
import type { WebhookSubscription } from '../../../src/types/index.js';

const conConfig = (retry_config: unknown): Pick<WebhookSubscription, 'retry_config'> =>
  ({ retry_config } as Pick<WebhookSubscription, 'retry_config'>);

/** Sin ruido: el azar se inyecta para poder comprobar la FÓRMULA. */
const sinRuido = (): number => 0.5;

describe('la política sale de la suscripción, del entorno o del defecto', () => {
  it('la suscripción manda cuando trae números utilizables', () => {
    const p = politicaDe(conConfig({ max_retries: 7, retry_interval_seconds: 30 }));
    expect(p.maxIntentos).toBe(7);
    expect(p.baseSegundos).toBe(30);
  });

  it('un retry_config ilegible NO tumba el barrido: cae al defecto', () => {
    // La columna es JSONB con DEFAULT, no un tipo: puede contener cualquier
    // cosa. Que una fila corrupta detuviera la cola entera sería peor que la
    // deuda que este módulo viene a pagar.
    for (const basura of [null, undefined, {}, { max_retries: 'muchos' }, { max_retries: NaN }]) {
      const p = politicaDe(conConfig(basura));
      expect(Number.isInteger(p.maxIntentos)).toBe(true);
      expect(p.maxIntentos).toBeGreaterThan(0);
      expect(p.baseSegundos).toBeGreaterThan(0);
    }
  });

  it('acota valores hostiles en vez de obedecerlos', () => {
    expect(politicaDe(conConfig({ max_retries: 0 })).maxIntentos).toBe(1);
    expect(politicaDe(conConfig({ max_retries: 100_000 })).maxIntentos).toBe(50);
    expect(politicaDe(conConfig({ retry_interval_seconds: -5 })).baseSegundos).toBe(1);
  });
});

describe('retroceso exponencial con tope', () => {
  const politica = { maxIntentos: 12, baseSegundos: 60, topeSegundos: TOPE_ESPERA_SEGUNDOS };

  it('duplica la espera en cada fallo', () => {
    expect(veredicto(1, politica, sinRuido).esperaSegundos).toBe(60);
    expect(veredicto(2, politica, sinRuido).esperaSegundos).toBe(120);
    expect(veredicto(3, politica, sinRuido).esperaSegundos).toBe(240);
    expect(veredicto(7, politica, sinRuido).esperaSegundos).toBe(3840);
  });

  it('el tope corta la duplicación: sin él, 20 intentos serían once años', () => {
    // 60 · 2^19 ≈ 31 507 200 s. El tope es lo que permite que el número de
    // intentos sea configurable sin que la configuración invente un plazo
    // absurdo.
    const largo = { maxIntentos: 25, baseSegundos: 60, topeSegundos: TOPE_ESPERA_SEGUNDOS };
    expect(veredicto(20, largo, sinRuido).esperaSegundos).toBe(TOPE_ESPERA_SEGUNDOS);
  });

  it('el ruido nunca rebasa el tope ni baja de un segundo', () => {
    const largo = { maxIntentos: 25, baseSegundos: 60, topeSegundos: TOPE_ESPERA_SEGUNDOS };
    for (const azar of [0, 0.25, 0.5, 0.75, 1]) {
      const v = veredicto(20, largo, () => azar);
      expect(v.esperaSegundos).toBeLessThanOrEqual(TOPE_ESPERA_SEGUNDOS);
      expect(v.esperaSegundos).toBeGreaterThanOrEqual(1);
    }
  });

  it('el ruido dispersa ±20 %: sin él, el receptor recibe la estampida entera', () => {
    const abajo = veredicto(2, politica, () => 0).esperaSegundos;
    const arriba = veredicto(2, politica, () => 1).esperaSegundos;
    expect(abajo).toBe(96); // 120 − 20 %
    expect(arriba).toBe(144); // 120 + 20 %
  });
});

describe('la ventana total, fijada para que el comentario no pueda mentir', () => {
  it('los defectos suman 20 h 31 min de vida para una entrega', () => {
    // El comentario de politica-reintento.ts defiende ESTE número. Si alguien
    // cambia maxIntentos, la base o el tope, esta prueba cae y obliga a
    // reescribir la defensa en vez de dejar el párrafo desactualizado.
    const politica = { maxIntentos: 12, baseSegundos: 60, topeSegundos: TOPE_ESPERA_SEGUNDOS };
    let total = 0;
    for (let n = 1; n < politica.maxIntentos; n++) {
      total += veredicto(n, politica, sinRuido).esperaSegundos;
    }
    expect(veredicto(politica.maxIntentos, politica, sinRuido).muerta).toBe(true);
    expect(total).toBe(73_860); // 20 h 31 min
    expect(total / 3600).toBeCloseTo(20.52, 2);
  });
});

describe('el tope de intentos declara la muerte', () => {
  const politica = { maxIntentos: 3, baseSegundos: 60, topeSegundos: TOPE_ESPERA_SEGUNDOS };

  it('antes del tope hay próxima fecha; en el tope no hay ninguna', () => {
    expect(veredicto(2, politica, sinRuido).muerta).toBe(false);
    expect(veredicto(2, politica, sinRuido).proximoIntento).toBeInstanceOf(Date);

    const muerta = veredicto(3, politica, sinRuido);
    expect(muerta.muerta).toBe(true);
    // NULL exactamente cuando está muerta: es el par (failed, NULL) el que
    // distingue «me rendí» de «sigo trabajando en ello», porque el CHECK de
    // la migración 003 no admite un cuarto valor de status.
    expect(muerta.proximoIntento).toBeNull();
  });

  it('un intento por encima del tope tampoco resucita', () => {
    expect(veredicto(9, politica, sinRuido).muerta).toBe(true);
  });

  it('la razón de muerte se escribe para quien la lea meses después', () => {
    const texto = razonDeMuerte(5, 'HTTP 503 Service Unavailable');
    expect(texto).toContain(MUERTA_PREFIJO);
    expect(texto).toContain('5 intento(s)');
    expect(texto).toContain('503');
    expect(texto).toContain('no se reintentará automáticamente');
  });

  it('sin error registrado la razón lo dice, en vez de quedar vacía', () => {
    expect(razonDeMuerte(3, '   ')).toContain('sin error registrado');
  });
});
