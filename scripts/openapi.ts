/**
 * Publica el contrato de la API REST, derivado de la API REST.
 *
 *   npx tsx scripts/openapi.ts             escribe docs/openapi.json
 *   npx tsx scripts/openapi.ts --check     sale con 1 si el archivo está desfasado
 *   npx tsx scripts/openapi.ts --stdout    lo imprime sin tocar el disco
 *
 * POR QUÉ EXISTE
 *
 * Había 50 esquemas de Zod validando cada cuerpo de petición y ninguna
 * especificación: quien integra contra esta API leía src/api/rest/routes o
 * adivinaba. Lo que este archivo NO hace es arreglar eso escribiendo un
 * openapi.yaml a mano — es exactamente el artefacto que este proyecto lleva un
 * mes retirando, y por la misma razón que se retiró la tabla de estado del plan
 * y el conteo de portada del catálogo: un espejo del código mantenido a mano se
 * desincroniza justo cuando el trabajo avanza.
 *
 * El documento sale del CENSO de la pila real de Express (src/api/rest/risk.ts,
 * G4a) y de las marcas que viajan en los propios manejadores: el esquema de
 * Zod, los permisos y la clase de riesgo. Nada de eso se copia.
 *
 * EL `--check` NO ES LA GUARDA PRINCIPAL. Lo que impide que el contrato se
 * pudra es tests/api/routes/openapi-contrato.spec.ts, que exige que la
 * especificación cubra TODAS las rutas del censo: una ruta nueva rompe la
 * prueba aunque nadie regenere nada. Esto de aquí sólo mantiene fresca la copia
 * que se lee sin ejecutar el proyecto.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import { montarSuperficieCensable } from '../src/api/rest/montajes.js';
import { construirOpenAPI } from '../src/api/rest/openapi.js';

const RAIZ = path.resolve(__dirname, '..');
const DESTINO = path.join(RAIZ, 'docs', 'openapi.json');

function documento(): string {
  const paquete = JSON.parse(
    fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')
  ) as { version?: string };
  const doc = construirOpenAPI(montarSuperficieCensable(express()), {
    version: paquete.version,
  });
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(args: string[]): number {
  const json = documento();

  if (args.includes('--stdout')) {
    process.stdout.write(json);
    return 0;
  }

  if (args.includes('--check')) {
    const actual = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8') : '';
    if (actual === json) {
      process.stdout.write('El contrato de la API está al día.\n');
      return 0;
    }
    process.stderr.write(
      `${path.relative(RAIZ, DESTINO)} no coincide con las rutas montadas.\n` +
        'Regenéralo con:  npx tsx scripts/openapi.ts\n'
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, json);
  process.stdout.write(`Contrato regenerado en ${path.relative(RAIZ, DESTINO)}.\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
