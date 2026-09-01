import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pg from 'pg';
import { config } from '../../config/index.js';
import { ValidationError } from '../../utils/errors.js';

const ejecutar = promisify(execFile);

// ============================================================
// RESPALDO Y RESTAURACIÓN (S3)
//
// POR QUÉ ES CONDICIÓN DE ENTREGA, y no una comodidad. Este sistema hizo su
// mayor no editable a propósito: desde la 041 un asiento posteado no admite
// UPDATE ni DELETE, y desde la 033 la bitácora sólo agrega. Esa
// inmutabilidad es lo que hace confiables los libros — y es exactamente lo
// que impide repararlos a mano cuando algo sale mal. La 041 llega a
// prescribir «bórrala entera y vuelve a migrar» como única salida ante un
// mayor inservible, es decir: la vía de recuperación que el propio esquema
// nombra ES la restauración. Hasta hoy no existía ni una línea sobre ella en
// todo el árbol.
//
// UN RESPALDO NO PROBADO NO ES UN RESPALDO. Por eso `verificar` no mira el
// archivo: lo RESTAURA en una base de usar y tirar y le corre los chequeos
// del mayor. Un volcado que no se puede restaurar no es un respaldo, es un
// archivo grande; y uno que restaura un mayor descuadrado es peor, porque
// promete lo que no tiene.
//
// LO QUE ESTE RESPALDO **NO** CUBRE, dicho aquí y en el manifiesto porque
// callarlo sería la clase de promesa que esta casa persigue: el material
// criptográfico vive FUERA de la base — la llave del vault
// (.mnemosine-vault/vault.key o el gestor de secretos) y ENCRYPTION_KEY. Un
// volcado restaurado sin ellas deja las cuentas bancarias, las CLABE y las
// credenciales fiscales como texto cifrado ilegible. El respaldo de esas
// llaves es del operador, y el manifiesto se lo recuerda cada vez.
// ============================================================

export interface Manifiesto {
  /** Versión del formato del manifiesto, para que un lector futuro sepa leerlo. */
  formato: 1;
  creado: string;
  /** La última migración aplicada: sin esto, restaurar es adivinar contra qué código. */
  esquema: { ultimaMigracion: string; migracionesAplicadas: number };
  base: string;
  archivo: string;
  bytes: number;
  /** SHA-256 del volcado: detecta corrupción silenciosa en el almacenamiento. */
  sha256: string;
  /** Lo que el volcado NO lleva. Se escribe SIEMPRE. */
  noIncluye: string[];
  verificacion?: {
    fecha: string;
    restauro: boolean;
    hallazgos: number;
    detalle: string;
  };
}

const NO_INCLUYE = [
  'La llave del vault (.mnemosine-vault/vault.key o el gestor de secretos): sin ella, ' +
    'las credenciales fiscales y los datos bancarios cifrados quedan ilegibles tras restaurar.',
  'ENCRYPTION_KEY del entorno: misma consecuencia.',
  'Los archivos XML/PDF que vivan fuera de la base (rutas en cfdi_xml_url / pdf_url).',
  'El archivado continuo (WAL/PITR) del motor: esto es un volcado lógico puntual, ' +
    'no un punto de recuperación arbitrario.',
];

export const SUFIJO = '.dump';
export const SUFIJO_MANIFIESTO = '.manifiesto.json';

/**
 * QUIÉN PUEDE RESPALDAR, y por qué no es una pregunta de permisos ordinaria.
 *
 * Descubierto CONSTRUYENDO esto: `pg_dump` como `mnemosine_owner` FALLA a
 * mitad del volcado —
 *
 *   ERROR: query would be affected by row-level security policy for table
 *   "account_balances"
 *
 * — porque toda tabla acotada lleva FORCE ROW LEVEL SECURITY y el dueño
 * también queda sujeto. Es la MISMA clase que dejaba el DML de migración en
 * cero filas, ahora sobre la vía de recuperación: el endurecimiento que
 * protege los datos impedía respaldarlos.
 *
 * Un respaldo tiene que ver TODAS las filas por definición, así que lo toma un
 * rol con BYPASSRLS (o superusuario) — BACKUP_DATABASE_URL. No se hereda del
 * migrador a propósito: son dos privilegios distintos y mezclarlos daría al
 * corredor de migraciones la capacidad de leerlo todo, que es justo lo que
 * NOBYPASSRLS le quita.
 *
 * DE AHÍ SALE EL ROL, NO LA BASE. Esa variable responde a «con qué privilegio
 * se vuelca», nunca a «qué se vuelca»; lo que se vuelca es la base que sirve la
 * aplicación. Tomar también su nombre de base era un defecto con la peor forma
 * posible: apuntada a un rol de respaldo cuya URL nombra otra base —la suya por
 * defecto, `postgres`, la que sea— el volcado salía de la base EQUIVOCADA con
 * todas las señales de salud intactas: manifiesto escrito, sha256 correcto,
 * migraciones contadas, `verify` restaurando sin un error. Un archivo que se
 * comporta como respaldo y no lo es, que es justo la mentira que este módulo
 * existe para no contar.
 *
 * El nombre sale de DATABASE_URL y sólo de ella, LEÍDA DEL ENTORNO. No de
 * `config.database.url`, que nunca está vacía: cae a un literal que nombra
 * `accounting_core` —el POSTGRES_DB de docker/docker-compose.yml, o sea una
 * base que en una máquina de desarrollo EXISTE—, así que confiar en ella
 * reintroduciría el mismo volcado sano y equivocado por la puerta de al lado,
 * disparado ahora por una variable ausente en vez de por una presente. Y
 * `.env.example` trae `DATABASE_URL=` vacía, que es exactamente ese caso.
 *
 * Y sin DATABASE_URL en el entorno NO se falla cerrado: se cae al nombre que la
 * PROPIA credencial trae. Ahí no hay mentira que evitar —el operador nombró esa
 * base explícitamente y es la que recibe—, y negarse rompería una instalación
 * que hoy respalda bien. Lo que el defecto tenía de grave era volcar una base
 * que NADIE nombró; sólo se rechaza cuando ninguna de las dos nombra ninguna.
 */
function urlAdmin(): string {
  const credencial =
    process.env.BACKUP_DATABASE_URL ?? config.database.migrationUrl ?? config.database.url;
  if (!credencial) {
    throw new ValidationError('No hay URL de base de datos configurada para respaldar.');
  }
  // Del entorno, no de config: config.database.url cae a un literal.
  const servida = process.env.DATABASE_URL;
  const base = (servida ? nombreDeBase(servida) : '') || nombreDeBase(credencial);
  if (!base) {
    throw new ValidationError(
      'Ninguna URL nombra una base que respaldar: DATABASE_URL dice QUÉ se vuelca y ' +
        'BACKUP_DATABASE_URL con qué privilegio, y ninguna de las dos trae nombre de base.'
    );
  }
  return urlConBase(credencial, base);
}

export interface Capacidad {
  puede: boolean;
  rol: string;
  motivo: string;
}

/** ¿Este rol puede volcar la base ENTERA, o RLS le esconderá filas? */
export async function puedeRespaldar(url: string): Promise<Capacidad> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ rol: string; superusuario: boolean; salta: boolean }>(
      `SELECT current_user AS rol, rolsuper AS superusuario, rolbypassrls AS salta
         FROM pg_roles WHERE rolname = current_user`
    );
    const f = r.rows[0];
    if (!f) return { puede: false, rol: '(desconocido)', motivo: 'no se pudo leer el rol actual' };
    if (f.superusuario) return { puede: true, rol: f.rol, motivo: 'superusuario' };
    if (f.salta) return { puede: true, rol: f.rol, motivo: 'BYPASSRLS' };
    return {
      puede: false,
      rol: f.rol,
      motivo:
        `el rol "${f.rol}" está sujeto a las políticas de aislamiento (FORCE ROW LEVEL SECURITY), ` +
        'así que pg_dump fallaría a mitad del volcado — y un respaldo parcial es peor que ninguno, ' +
        'porque parece uno.\n' +
        'Apunta BACKUP_DATABASE_URL a un rol con BYPASSRLS (o superusuario): un respaldo tiene que ' +
        'ver todas las filas por definición. No se hereda del migrador a propósito.',
    };
  } finally {
    await client.end();
  }
}

function nombreDeBase(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function urlConBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

async function sha256De(archivo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(archivo);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function estadoDelEsquema(url: string): Promise<Manifiesto['esquema']> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ ultima: string | null; n: string }>(
      `SELECT max(filename) AS ultima, count(*)::text AS n FROM public.migrations`
    );
    return {
      ultimaMigracion: r.rows[0]?.ultima ?? '(ninguna)',
      migracionesAplicadas: Number(r.rows[0]?.n ?? 0),
    };
  } finally {
    await client.end();
  }
}

export interface OpcionesRespaldo {
  /** Directorio destino. Se crea si no existe. */
  destino: string;
  /** Sólo para pruebas: fija el nombre en vez de derivarlo del reloj. */
  nombre?: string;
}

export interface ResultadoRespaldo {
  archivo: string;
  manifiestoEn: string;
  manifiesto: Manifiesto;
}

/**
 * El volcado, en formato `custom` de Postgres: comprimido, restaurable con
 * pg_restore y —lo que importa— restaurable SELECTIVAMENTE, que es lo que
 * hace falta cuando lo que se perdió es una tabla y no la base entera.
 */
export async function crearRespaldo(opts: OpcionesRespaldo): Promise<ResultadoRespaldo> {
  const url = urlAdmin();
  const base = nombreDeBase(url);
  fs.mkdirSync(opts.destino, { recursive: true });

  const sello = opts.nombre ?? new Date().toISOString().replace(/[:.]/g, '-');
  const archivo = path.join(opts.destino, `${base}-${sello}${SUFIJO}`);

  // Se comprueba ANTES de escribir un archivo: un volcado a medias con
  // nombre de respaldo es exactamente la mentira que este comando no puede
  // permitirse.
  const capacidad = await puedeRespaldar(url);
  if (!capacidad.puede) throw new ValidationError(capacidad.motivo);

  const esquema = await estadoDelEsquema(url);

  try {
    await ejecutar('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', archivo, url], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    const e = err as { stderr?: string; code?: string; message: string };
    if (e.code === 'ENOENT') {
      throw new ValidationError(
        'pg_dump no está en el PATH: el respaldo lo hace la herramienta de Postgres, no este proceso. ' +
          'Instala el cliente de PostgreSQL (postgresql-client) y vuelve a intentarlo.'
      );
    }
    throw new ValidationError(`pg_dump falló: ${e.stderr?.trim() || e.message}`);
  }

  const manifiesto: Manifiesto = {
    formato: 1,
    creado: new Date().toISOString(),
    esquema,
    base,
    archivo: path.basename(archivo),
    bytes: fs.statSync(archivo).size,
    sha256: await sha256De(archivo),
    noIncluye: NO_INCLUYE,
  };
  const manifiestoEn = `${archivo}${SUFIJO_MANIFIESTO}`;
  fs.writeFileSync(manifiestoEn, JSON.stringify(manifiesto, null, 2) + '\n');
  return { archivo, manifiestoEn, manifiesto };
}

export interface Respaldo {
  archivo: string;
  manifiesto: Manifiesto | null;
  /** El manifiesto existe y su sha256 casa con el archivo de hoy. */
  integro: boolean | null;
}

export async function listarRespaldos(directorio: string): Promise<Respaldo[]> {
  if (!fs.existsSync(directorio)) return [];
  const salida: Respaldo[] = [];
  for (const nombre of fs.readdirSync(directorio).sort().reverse()) {
    if (!nombre.endsWith(SUFIJO)) continue;
    const archivo = path.join(directorio, nombre);
    const rutaManifiesto = `${archivo}${SUFIJO_MANIFIESTO}`;
    let manifiesto: Manifiesto | null = null;
    let integro: boolean | null = null;
    if (fs.existsSync(rutaManifiesto)) {
      try {
        manifiesto = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf-8')) as Manifiesto;
        integro = manifiesto.sha256 === (await sha256De(archivo));
      } catch {
        manifiesto = null;
      }
    }
    salida.push({ archivo, manifiesto, integro });
  }
  return salida;
}

export interface ResultadoVerificacion {
  archivo: string;
  /** El volcado se restauró de punta a punta en una base nueva. */
  restauro: boolean;
  /** sha256 del manifiesto contra el archivo de hoy. */
  integro: boolean | null;
  /** Hallazgos de los chequeos del mayor sobre lo restaurado, por entidad. */
  hallazgos: { entidad: string; check: string; severity: string; referencia: string; detalle: string }[];
  entidadesRevisadas: number;
  detalle: string;
}

/**
 * LA VERIFICACIÓN QUE IMPORTA: restaura de verdad y le corre los chequeos.
 *
 * Se restaura en una base efímera con nombre propio y se destruye siempre —
 * también si algo revienta a mitad. Nunca toca la base de origen.
 */
export async function verificarRespaldo(archivo: string): Promise<ResultadoVerificacion> {
  if (!fs.existsSync(archivo)) {
    throw new ValidationError(`No existe el respaldo: ${archivo}`);
  }
  const url = urlAdmin();
  const rutaManifiesto = `${archivo}${SUFIJO_MANIFIESTO}`;
  let integro: boolean | null = null;
  if (fs.existsSync(rutaManifiesto)) {
    const m = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf-8')) as Manifiesto;
    integro = m.sha256 === (await sha256De(archivo));
  }

  const efimera = `mnemosine_verif_${crypto.randomBytes(4).toString('hex')}`;
  const raiz = new pg.Client({ connectionString: urlConBase(url, 'postgres') });
  await raiz.connect();
  let restauro = false;
  let detalle = '';
  const hallazgos: ResultadoVerificacion['hallazgos'] = [];
  let entidadesRevisadas = 0;

  try {
    await raiz.query(`CREATE DATABASE ${efimera}`);
    try {
      await ejecutar(
        'pg_restore',
        ['--no-owner', '--no-privileges', '--dbname', urlConBase(url, efimera), archivo],
        { maxBuffer: 1024 * 1024 * 64 }
      );
      restauro = true;
    } catch (err) {
      // pg_restore avisa por stderr de cosas benignas (roles ausentes) y sale
      // distinto de cero; lo que decide es si la base quedó utilizable, y eso
      // se comprueba consultándola, no leyendo su bitácora.
      const e = err as { stderr?: string; message: string };
      detalle = (e.stderr ?? e.message).trim().split('\n').slice(-3).join(' · ');
    }

    // ¿Quedó utilizable? Se le pregunta a la base, no al proceso.
    const restaurada = new pg.Client({ connectionString: urlConBase(url, efimera) });
    await restaurada.connect();
    try {
      const entidades = await restaurada.query<{ id: string; name: string }>(
        `SELECT id, name FROM legal_entities ORDER BY name`
      );
      restauro = true;
      entidadesRevisadas = entidades.rows.length;

      // Los chequeos del mayor corren contra LA BASE RESTAURADA: se apunta el
      // pool de la aplicación a ella durante la comprobación. Es el único
      // modo de que «el respaldo sirve» signifique lo que dice.
      const anterior = process.env.DATABASE_URL;
      process.env.DATABASE_URL = urlConBase(url, efimera);
      try {
        const { cerrarPoolPorRespaldo, runLedgerChecksEn } = await import('./ledger-en-base.js');
        for (const e of entidades.rows) {
          const encontrados = await runLedgerChecksEn(urlConBase(url, efimera), e.id);
          for (const f of encontrados) {
            hallazgos.push({
              entidad: e.name, check: f.check, severity: f.severity,
              referencia: f.referencia, detalle: f.detalle,
            });
          }
        }
        await cerrarPoolPorRespaldo();
      } finally {
        if (anterior === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = anterior;
      }
    } finally {
      await restaurada.end();
    }
  } finally {
    await raiz
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${efimera}'`)
      .catch(() => undefined);
    await raiz.query(`DROP DATABASE IF EXISTS ${efimera}`).catch(() => undefined);
    await raiz.end();
  }

  const resultado: ResultadoVerificacion = {
    archivo,
    restauro,
    integro,
    hallazgos,
    entidadesRevisadas,
    detalle:
      detalle ||
      (restauro
        ? `restaurado y revisado: ${entidadesRevisadas} entidad(es), ${hallazgos.length} hallazgo(s)`
        : 'no se pudo restaurar'),
  };

  // La verificación se anota EN el manifiesto: un respaldo verificado hace
  // meses y uno verificado hoy no valen lo mismo, y sin fecha no se
  // distinguen.
  if (fs.existsSync(rutaManifiesto)) {
    const m = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf-8')) as Manifiesto;
    m.verificacion = {
      fecha: new Date().toISOString(),
      restauro,
      hallazgos: hallazgos.length,
      detalle: resultado.detalle,
    };
    fs.writeFileSync(rutaManifiesto, JSON.stringify(m, null, 2) + '\n');
  }
  return resultado;
}

export interface ResultadoRestauracion {
  archivo: string;
  destino: string;
  creada: boolean;
}

/**
 * Restaura EN UNA BASE NUEVA, siempre. Nunca sobre una existente.
 *
 * Sobrescribir una base viva es la clase de acto que no se puede deshacer y
 * que, mal ejecutado, destruye justo lo que se quería salvar. Aquí se
 * restaura al lado, y el cambio de destino —apuntar la aplicación a la base
 * nueva— es un acto deliberado del operador, con la base vieja todavía
 * intacta por si la restauración no era lo que creía.
 */
export async function restaurarRespaldo(
  archivo: string,
  destino: string
): Promise<ResultadoRestauracion> {
  if (!fs.existsSync(archivo)) throw new ValidationError(`No existe el respaldo: ${archivo}`);
  if (!/^[a-z_][a-z0-9_]*$/.test(destino)) {
    throw new ValidationError(
      `Nombre de base inválido: "${destino}". Sólo minúsculas, dígitos y guión bajo.`
    );
  }
  const url = urlAdmin();
  const raiz = new pg.Client({ connectionString: urlConBase(url, 'postgres') });
  await raiz.connect();
  try {
    const existe = await raiz.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [destino]);
    if (existe.rows.length > 0) {
      throw new ValidationError(
        `La base "${destino}" ya existe. La restauración crea una base NUEVA a propósito: ` +
          'sobrescribir una viva destruiría lo que se intenta salvar. Elige otro nombre.'
      );
    }
    await raiz.query(`CREATE DATABASE ${destino}`);
  } finally {
    await raiz.end();
  }
  await ejecutar(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--dbname', urlConBase(url, destino), archivo],
    { maxBuffer: 1024 * 1024 * 64 }
  ).catch((err: { stderr?: string; message: string }) => {
    // Igual que en la verificación: pg_restore avisa de cosas benignas. Se
    // reporta, no se oculta, y el operador verifica con `backup verify`.
    process.stderr.write(`Avisos de pg_restore: ${(err.stderr ?? err.message).trim()}\n`);
  });
  return { archivo, destino, creada: true };
}
