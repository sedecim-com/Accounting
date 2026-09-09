import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// ============================================================
// LA SEGUNDA PUERTA AL MAYOR, RETIRADA (T14b · #101).
//
// Había una API de GraphQL —1 862 líneas en cuatro archivos, Apollo Server—
// montada en /graphql, FUERA del prefijo auditado, con mutaciones que posteaban
// al mayor y cerraban ejercicios. Estaba apagada tras GRAPHQL_ENABLED y no la
// consumía nadie: ningún cliente en el árbol, ningún .graphql, y el script
// `graphql:codegen` que prometía generar uno no tenía ni binario.
//
// El argumento escrito para conservarla en vez de borrarla era este, en
// src/index.ts: «It is gated rather than deleted because this repository has no
// version control, and 891 lines are not recoverable once removed». Hay control
// de versiones, y eran el doble de líneas de las que ese comentario contaba.
//
// Esta suite existe por la misma razón que withdrawn-endpoints.spec.ts: para
// que una mano futura no pueda devolverla en silencio. Y afirma HECHOS
// POSITIVOS, no la ausencia de una palabra — que es exactamente como se cegaba
// el criterio que la vigilaba: bastaba mudar el montaje de archivo para que
// dijera «GraphQL no está montado» con la superficie sirviendo.
// ============================================================

const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string): string => readFileSync(join(RAIZ, rel), 'utf-8');

/**
 * Todos los .ts bajo src/, que es donde una puerta podría volver a montarse.
 *
 * `src/plan` queda fuera por la misma razón que lo deja fuera `fuentes()` en
 * src/plan/criterios.ts: ese archivo CITA los patrones que persigue, así que
 * un barrido que lo incluyera se acusaría a sí mismo — el criterio
 * `graphql-surface-withdrawn` lleva dentro las cadenas `@apollo/` y
 * `api/graphql/` porque son justo lo que busca. El instrumento de medida no se
 * mide.
 */
function fuentesTs(dir = join(RAIZ, 'src')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    if (relative(RAIZ, join(dir, e.name)) === join('src', 'plan')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...fuentesTs(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** El fuente sin comentarios: los que cuentan esta historia son deliberados. */
const sinComentarios = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('la superficie no está en el árbol', () => {
  it('src/api/graphql no existe', () => {
    expect(existsSync(join(RAIZ, 'src', 'api', 'graphql'))).toBe(false);
  });

  it('ni sus pruebas, que sólo existían para ella', () => {
    // 102 pruebas de `blindar`, `auditarRaiz` y `blindarCampos`: la compuerta
    // de permisos que se construyó para esta puerta y para ninguna otra.
    expect(existsSync(join(RAIZ, 'tests', 'api', 'graphql'))).toBe(false);
  });
});

describe('no puede volver a instalarse sin que se vea', () => {
  const paquete = leer('package.json');

  it('package.json no declara ninguno de los cuatro paquetes', () => {
    // El ancla DURA: el directorio se renombra, pero un servidor de Apollo no
    // se monta sin su paquete. Por eso el criterio del tablero mide esto y no
    // dónde vive el montaje.
    expect(paquete).not.toMatch(/"@apollo\/server"\s*:/);
    expect(paquete).not.toMatch(/"@graphql-tools\/[^"]+"\s*:/);
    expect(paquete).not.toMatch(/"@as-integrations\/[^"]+"\s*:/);
    expect(paquete).not.toMatch(/"graphql"\s*:/);
  });

  it('ni el script de generación de cliente que nunca tuvo binario', () => {
    expect(paquete).not.toMatch(/graphql:codegen/);
  });

  it('y el lock tampoco los trae, que es lo que decide qué instala `npm ci`', () => {
    // package.json es la intención; el lock es lo que de verdad se instala en
    // CI. Sin esta comprobación, quitar la dependencia y olvidar el lock deja
    // los paquetes entrando por la puerta de atrás.
    const lock = JSON.parse(leer('package-lock.json')) as { packages: Record<string, unknown> };
    const restos = Object.keys(lock.packages).filter((k) =>
      /(^|\/)(@apollo\/|@graphql-tools\/|@as-integrations\/|graphql)($|\/)/.test(k)
    );
    expect(restos, `el lock todavía instala: ${restos.join(', ')}`).toEqual([]);
  });
});

describe('ningún fuente la importa ni la vuelve a montar', () => {
  it('nadie importa apollo ni graphql', () => {
    const importadores = fuentesTs()
      .filter((f) => /@apollo\/|from 'graphql'|api\/graphql\//.test(sinComentarios(readFileSync(f, 'utf-8'))))
      .map((f) => relative(RAIZ, f));
    expect(importadores).toEqual([]);
  });

  it('y nada se monta en /graphql', () => {
    // La ruta iba FUERA de /v1, así que se saltaba el middleware de auditoría
    // que toda ruta REST lleva: lo que pasaba por ahí no dejaba la fila de
    // petición con IP, agente y request_id.
    expect(sinComentarios(leer('src/index.ts'))).not.toMatch(/['"]\/graphql['"]/);
  });
});

describe('lo que la amputación se llevó de propina, y lo que dejó en pie', () => {
  it('la CSP ya no lleva la excepción del CDN que sólo servía al playground', () => {
    // Ganancia, no daño colateral: helmet corría con `script-src` y
    // `style-src` ampliados a un CDN y con 'unsafe-inline' porque la landing
    // del playground los pedía. Sin playground, la excepción sobra.
    const idx = sinComentarios(leer('src/index.ts'));
    expect(idx).not.toMatch(/cdn\.jsdelivr\.net/);
    expect(idx).not.toMatch(/cspPlayground/);
    expect(idx).toMatch(/app\.use\(helmet\(\)\);/);
  });

  it('el candado de cuatro ojos sigue siendo uno solo, y compartido', () => {
    // Es la defensa que las pruebas retiradas ejercían por la tercera puerta.
    // El HECHO sobrevive a la puerta: sigue extraído y sigue probado por REST y
    // por el motor que usa el CLI, en g3-candado-de-una-sola-puerta.
    const posting = leer('src/services/accounting/posting.ts');
    expect(posting).toMatch(/async function autorizarPosteo/);
    expect(posting).toMatch(/export async function exigirSegregacion/);
  });

  it('y la API REST sigue montándose por la tabla compartida', () => {
    expect(leer('src/api/rest/montajes.ts')).toMatch(/MONTAJES_V1/);
    expect(sinComentarios(leer('src/index.ts'))).toMatch(/montarSuperficieCensable|MONTAJES_V1/);
  });
});
