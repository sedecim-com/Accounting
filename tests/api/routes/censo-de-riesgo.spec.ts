import { describe, it, expect, vi } from 'vitest';
import express, { Router, type Express } from 'express';

// ============================================================
// EL CENSO DE RIESGO DE RUTAS, PROBADO CONTRA LA APP DE VERDAD.
//
// El CLI no arranca si una hoja declara a la vez «irreversible» y
// «accesible al agente»: `declareRisk` lanza al registrar el comando
// (src/cli/kernel/risk.ts). La API no tenía nada de eso — 87 rutas que
// mutan, ninguna declaraba — y por ese hueco una de ellas llegó a postear
// al mayor saltándose el control de cuatro ojos que el CLI declaraba no
// exponer.
//
// Esta suite sostiene la mitad que no se puede comprobar leyendo: que la
// declaración no es opcional. No monta un router de juguete — monta la
// MISMA tabla que monta src/index.ts (MONTAJES_V1, que existe para poder
// compartirse en vez de copiarse) y le hace el mismo censo que corre en el
// arranque. Si alguien añade mañana un POST sin declarar, la prueba de
// abajo falla por el mismo motivo por el que fallaría el servidor.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import {
  MONTAJES_V1,
  MONTAJES_FUERA_DE_V1,
  montarSuperficieCensable,
} from '../../../src/api/rest/montajes.js';
import {
  declararRiesgoRuta,
  auditarRiesgoDeRutas,
  resumirCenso,
  censarRutas,
  VERBOS_QUE_MUTAN,
  type RiesgoRuta,
} from '../../../src/api/rest/risk.js';

/**
 * La app tal como la arma src/index.ts: la tabla compartida bajo /v1, más
 * los dos montajes que van fuera del prefijo autenticado. Sin JWT ni base:
 * el censo mira lo que Express registró, no lo que las rutas contestan.
 *
 * Los dos montajes de fuera se copiaban aquí a mano hasta que el contrato de
 * la API (G4b) necesitó la misma superficie y montajes.ts la compartió:
 * ahora los tres instrumentos —este censo, el contrato y quien venga— miran
 * exactamente lo mismo, que es de lo que trata este archivo.
 */
function montarApiReal(): Express {
  return montarSuperficieCensable(express());
}

describe('censo de riesgo de rutas', () => {
  it('ninguna ruta que muta queda sin declarar en la API montada', () => {
    const { sinDeclarar } = resumirCenso(montarApiReal());
    // El mensaje del expect lleva la lista, para que el fallo diga QUÉ ruta
    // falta en vez de sólo cuántas.
    expect(sinDeclarar.map((r) => `${r.metodo.toUpperCase()} ${r.ruta}`)).toEqual([]);
  });

  it('las 87 rutas que mutan están declaradas, con su reparto por clase', () => {
    // Se cuenta sobre los routers DISTINTOS, no sobre la app: xml-ingestion y
    // blockchain se montan dos veces cada uno, y contar la app duplicaría sus
    // rutas. Lo que se cuenta aquí es cuántas rutas hay escritas, no cuántas
    // direcciones las alcanzan.
    const vistos = new Set<Router>();
    const porClase: Record<RiesgoRuta, number> = {
      lectura: 0, escritura: 0, irreversible: 0, externo: 0,
    };
    let mutantes = 0;
    const routers: Router[] = [
      ...MONTAJES_V1.map(([, r]) => r),
      ...MONTAJES_FUERA_DE_V1.map(([, r]) => r),
    ];
    for (const router of routers) {
      if (vistos.has(router)) continue;
      vistos.add(router);
      for (const ruta of censarRutas(router)) {
        if (VERBOS_QUE_MUTAN.includes(ruta.metodo)) mutantes += 1;
        if (ruta.riesgo) porClase[ruta.riesgo.riesgo] += 1;
      }
    }

    expect(mutantes).toBe(87);
    // La suma da 87 exactamente: sólo las rutas que mutan declaran, y todas
    // declaran. Cuatro de ellas se declaran `lectura` — son POST que calculan
    // y contestan sin escribir nada, y la clase describe el acto, no el verbo.
    expect(porClase).toEqual({
      lectura: 4,
      // 46 y no 47: `POST /upload` se movió a `irreversible` cuando el ataque
      // lo comparó con su hoja gemela del binario. `mnemosine ingest` declara
      // irreversible «con auto-posteo, asientos POSTEADOS», y la ruta hace
      // exactamente eso — processXMLUpload → processToAccounting →
      // createJournalEntry({ autoPost: true }) — mientras se declaraba
      // escritura. El mismo acto no puede tener dos clases según la puerta.
      escritura: 46,
      irreversible: 23,
      externo: 14,
    });
  });

  it('añadir una ruta de escritura sin declarar rompe el arranque', () => {
    const app = montarApiReal();

    // Hasta aquí, la app real pasa el censo.
    expect(() => auditarRiesgoDeRutas(app)).not.toThrow();

    // Y ahora la ruta que a nadie se le olvidaría declarar... si algo la
    // obligara. Es exactamente el aspecto que tenían las 87 antes de G4a.
    const nuevo = Router();
    nuevo.post('/aprobar-todo', (_req, res) => res.json({ ok: true }));
    app.use('/v1/experimentos', nuevo);

    expect(() => auditarRiesgoDeRutas(app)).toThrow(/POST \/v1\/experimentos\/aprobar-todo/);
    // Y el error dice qué hacer, no sólo que algo está mal.
    expect(() => auditarRiesgoDeRutas(app)).toThrow(/declararRiesgoRuta/);
  });

  it('un GET sin declarar no rompe nada: un GET es una lectura', () => {
    const app = montarApiReal();
    const nuevo = Router();
    nuevo.get('/algo', (_req, res) => res.json({ ok: true }));
    app.use('/v1/experimentos', nuevo);
    expect(() => auditarRiesgoDeRutas(app)).not.toThrow();
  });

  it('el censo alcanza un router montado dos veces, por sus dos direcciones', () => {
    const rutas = censarRutas(montarApiReal()).map((r) => `${r.metodo} ${r.ruta}`);
    expect(rutas).toContain('post /v1/xml/upload');
    expect(rutas).toContain('post /v1/upload');
    expect(rutas).toContain('post /v1/admin/blockchain/commit-period');
    expect(rutas).toContain('post /v1/admin/commit-period');
  });
});

describe('las combinaciones que el CLI prohíbe, prohibidas también aquí', () => {
  it('irreversible y agente juntos no se pueden declarar', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'irreversible', agente: true })).toThrow(
      /no postea al mayor/
    );
  });

  it('externo y agente juntos tampoco', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'externo', agente: true })).toThrow(
      /no alcanza a un tercero/
    );
  });

  it('una escritura para el agente exige afirmar soloBorrador', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'escritura', agente: true })).toThrow(
      /soloBorrador/
    );
    expect(() =>
      declararRiesgoRuta({ riesgo: 'escritura', agente: true, soloBorrador: true })
    ).not.toThrow();
  });

  it('soloBorrador sin agente no significa nada y se rechaza', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'escritura', soloBorrador: true })).toThrow(
      /sin declarar agente/
    );
  });

  it('el agente sí puede leer', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'lectura', agente: true })).not.toThrow();
  });
});

describe('las clases que más importa no equivocar', () => {
  const clases = new Map(
    censarRutas(montarApiReal()).map((r) => [`${r.metodo} ${r.ruta}`, r.riesgo?.riesgo])
  );

  it.each([
    // Postear al mayor es irreversible.
    ['post /v1/journal-entries/:id/post', 'irreversible'],
    // La ingesta postea cuando la regla del inquilino puso el pre-registro en
    // automático, así que es irreversible por sus dos direcciones — igual que
    // `mnemosine ingest`, que es la misma cosa por la otra puerta.
    ['post /v1/xml/upload', 'irreversible'],
    ['post /v1/upload', 'irreversible'],
    ['post /v1/payroll/pay-runs/:id/post-to-gl', 'irreversible'],
    ['post /v1/bills/:id/approve', 'irreversible'],
    ['post /v1/invoices/:id/payments', 'irreversible'],
    // Timbrar ante un PAC es externo.
    ['post /v1/invoices/:id/cfdi/stamp', 'externo'],
    ['post /v1/invoices/:id/cfdi/cancel', 'externo'],
    ['post /v1/payroll/paychecks/:id/cfdi-nomina', 'externo'],
    // Crear un borrador es escritura.
    ['post /v1/invoices', 'escritura'],
    ['post /v1/accounts', 'escritura'],
    ['post /v1/payroll/pay-runs', 'escritura'],
    // Un POST que sólo calcula es lectura, verbo aparte.
    ['post /v1/payroll/finiquito', 'lectura'],
    ['post /public/v1/verify/merkle-proof', 'lectura'],
  ])('%s está declarada %s', (ruta, esperada) => {
    expect(clases.get(ruta)).toBe(esperada);
  });

  it('ninguna ruta que mute es accesible al agente todavía', () => {
    // No es una limitación de este tramo: es su resultado. Ninguna ruta de la
    // API afirma hoy `soloBorrador`, así que ninguna escritura puede abrirse
    // al agente sin escribir esa afirmación y sostenerla.
    const abiertas = censarRutas(montarApiReal()).filter(
      (r) => VERBOS_QUE_MUTAN.includes(r.metodo) && r.riesgo?.agentePermitido
    );
    expect(abiertas.map((r) => `${r.metodo} ${r.ruta}`)).toEqual([]);
  });
});
