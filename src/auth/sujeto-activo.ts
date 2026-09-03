import { config } from '../config/index.js';
import { verifyIdpToken } from './oidc.js';
import { loadToken, isFresh } from './token-store.js';

// ============================================================
// QUIÉN FIRMA — EL SUJETO QUE SÍ SE COMPROBÓ (G3).
//
// El OIDC de la terminal llevaba meses ENTERO —`login` con PKCE y con
// código de dispositivo, llavero del sistema, caducidad, `loadToken()`—
// y ningún comando contable lo consumía: cero llamadas a `loadToken`
// fuera de su propio almacén y del `whoami` que sólo lo imprime.
//
// Mientras tanto la atribución de TODO hecho contable la escribía
// `--user <correo>`: una cadena que teclea quien ejecuta el comando.
// Ese correo llegaba a `journal_entries.created_by` y de ahí a
// `audit_log.user_id`, que es append-only desde la 033. Es decir: el
// sistema certificaba con toda ceremonia, y de forma irreversible, a
// quien nadie había autenticado. «Probar quién hizo qué» consistía en
// repetir lo que el autor dijo de sí mismo.
//
// Este módulo es el ÚNICO sitio donde se contesta «¿quién eres?», y
// contesta con una de tres cosas, nunca con un silencio:
//
//   · un sujeto verificado contra el proveedor,
//   · null porque este despliegue no tiene proveedor que preguntar,
//   · una excepción porque lo hay y la sesión no se sostiene.
//
// LA REGLA QUE IMPLEMENTA `decidirSujeto`: la bandera puede RESTRINGIR,
// jamás SUSTITUIR. Nombrarte a ti mismo es un no-op que se acepta;
// nombrar a otro con sesión abierta se rechaza. Afirmar ser otro no es
// una opción de línea de comandos.
// ============================================================

/** El sujeto que un proveedor de identidad confirmó. */
export interface SujetoAutenticado {
  /** El `sub` del proveedor: no cambia aunque cambie el correo. */
  subject: string;
  email: string;
  issuer: string;
}

/**
 * Había credencial y no sirve. Es DISTINTO de no tener ninguna: una
 * sesión caducada o irreconocible no puede degradar a la bandera sin
 * decirlo, porque ése es exactamente el silencio que este tramo cierra.
 */
export class SesionNoVerificableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesionNoVerificableError';
  }
}

/** `--user` nombrando a un tercero con sesión abierta. */
export class SuplantacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuplantacionError';
  }
}

/**
 * ¿Este despliegue declaró tener proveedor de identidad?
 *
 * Es la bifurcación entera del tramo. Un despliegue que configuró
 * AUTH_OIDC_ISSUER y AUTH_OIDC_AUDIENCE afirmó que puede autenticar, y
 * a partir de ahí una escritura sin sesión es un defecto, no un uso.
 * Uno que no los configuró no tiene con qué comprobar nada, y romperlo
 * sería cambiar el producto por decreto: ahí la bandera sigue siendo la
 * única identidad que existe, pero se registra como DECLARADA.
 */
export function autenticacionExigida(): boolean {
  return config.auth.enabled;
}

let enCurso: Promise<SujetoAutenticado | null> | null = null;

/**
 * El sujeto de la sesión guardada, verificado contra el proveedor.
 *
 * Se verifica la FIRMA, no se decodifica y ya. Leer las reivindicaciones
 * de un JWT sin comprobarlas movería el defecto de sitio en vez de
 * cerrarlo: quien pudiera escribir `~/.mnemosine/credentials.json`
 * fabricaría un token sin firma que dijese `email: beto@despacho.mx`, y
 * habríamos cambiado una bandera que miente por un archivo que miente.
 *
 * El coste es una consulta al proveedor por proceso —el descubrimiento y
 * el JWKS se memorizan dentro de `oidc.ts`— y la promesa se memoriza
 * aquí para que un comando con varias escrituras pregunte una sola vez.
 */
export async function sujetoAutenticado(): Promise<SujetoAutenticado | null> {
  enCurso ??= resolverSujeto();
  return enCurso;
}

/** Sólo para pruebas: olvida la sesión memorizada de este proceso. */
export function reiniciarSujetoActivo(): void {
  enCurso = null;
}

async function resolverSujeto(): Promise<SujetoAutenticado | null> {
  // Sin proveedor configurado no hay nada contra qué verificar. No se
  // mira siquiera el llavero: una credencial guardada que no podemos
  // comprobar no es una sesión, y tratarla como tal sería creerle.
  if (!config.auth.enabled) return null;

  const token = await loadToken();
  if (!token) return null;

  if (token.issuer !== config.auth.issuer) {
    throw new SesionNoVerificableError(
      `Tu sesión es de ${token.issuer} y este despliegue autentica contra ${config.auth.issuer}. ` +
        'Vuelve a entrar con `mnemosine login`.'
    );
  }

  // El margen es cero a propósito: `isFresh` por omisión descarta un
  // token que caduca dentro de un minuto para no usarlo en vuelo, y aquí
  // lo único que se pregunta es si ya caducó.
  if (!isFresh(token, 0)) {
    throw new SesionNoVerificableError(
      'Tu sesión caducó. Vuelve a entrar con `mnemosine login` — la renovación automática ' +
        'no se ha ejercido en este proceso y una atribución no se firma con una credencial muerta.'
    );
  }

  let identidad;
  try {
    identidad = await verifyIdpToken(token.accessToken, {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
  } catch (err) {
    throw new SesionNoVerificableError(
      `Tu sesión no la acepta el proveedor: ${err instanceof Error ? err.message : String(err)}. ` +
        'Vuelve a entrar con `mnemosine login`.'
    );
  }

  if (!identidad.email) {
    throw new SesionNoVerificableError(
      'El proveedor no envía correo en el token: no hay con qué atribuir el hecho a un usuario del inquilino.'
    );
  }

  // UN CORREO SIN VERIFICAR NO ELIGE USUARIO LOCAL. El correo es la
  // llave con la que la sesión encuentra su fila en `users`; aceptarlo
  // sin que el proveedor lo haya comprobado permitiría darse de alta
  // como `beto@despacho.mx` en un IdP permisivo y heredar el usuario de
  // Beto. Es la misma suplantación de antes, sólo que más cara.
  if (!identidad.emailVerified) {
    throw new SesionNoVerificableError(
      `El proveedor no da por verificado el correo ${identidad.email}: no se usa para atribuir asientos. ` +
        'Verifícalo en el proveedor, o vincula la identidad al usuario a mano.'
    );
  }

  return { subject: identidad.subject, email: identidad.email, issuer: identidad.issuer };
}

/** Dos correos son el mismo sujeto si sólo difieren en espacios y caja. */
export function mismoCorreo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Lo que decide `decidirSujeto`: a quién se atribuye y con cuánta prueba. */
export interface SujetoElegido {
  /** El correo al que se atribuirá. `undefined` = dedúzcalo el inquilino. */
  email: string | undefined;
  /** El `sub` del proveedor cuando hubo sesión; sirve para atar por identidad. */
  subject?: string;
  /** ¿Lo comprobó alguien, o sólo lo dijo la bandera? */
  autenticado: boolean;
}

/**
 * LA REGLA, sin llavero ni red, para que se pueda probar de verdad.
 *
 * `sesion` es lo que `sujetoAutenticado()` devolvió; `declarado`, lo que
 * traía `--user`.
 */
export function decidirSujeto(
  sesion: SujetoAutenticado | null,
  declarado: string | undefined,
  opts: { exigeAutenticacion: boolean }
): SujetoElegido {
  if (sesion) {
    if (declarado && !mismoCorreo(declarado, sesion.email)) {
      // Podría acotar —mirar con menos permisos que los tuyos— pero eso
      // no es lo que hace aquí: `resolveReviewer` atribuye ESCRITURAS, y
      // atribuir a un tercero no es restringirse, es firmar con su
      // nombre. La restricción de lectura, si llega, es otra bandera.
      throw new SuplantacionError(
        `Tu sesión es de ${sesion.email} y --user dice ${declarado}. ` +
          'La bandera puede acotar lo que ves, nunca decir que eres otro: el hecho se atribuiría ' +
          'a alguien que no lo hizo, y la bitácora no se puede corregir después (es append-only). ' +
          `Si quieres actuar como ${declarado}, entra como ${declarado}.`
      );
    }
    return { email: sesion.email, subject: sesion.subject, autenticado: true };
  }

  if (opts.exigeAutenticacion) {
    throw new SesionNoVerificableError(
      'Este despliegue tiene proveedor de identidad y no hay sesión abierta. ' +
        'Entra con `mnemosine login`: sin eso, --user no es una identidad, es una afirmación.'
    );
  }

  // Sin proveedor no se rompe a nadie: la bandera sigue siendo la única
  // identidad disponible. Pero deja de ser silenciosa.
  return { email: declarado, autenticado: false };
}

let yaAvisado = false;

/**
 * El aviso de la degradación, una vez por proceso y por stderr.
 *
 * Por stderr porque los datos van por stdout y una tubería no se
 * corrompe por un aviso (regla del kernel de salida). Una vez porque un
 * comando resuelve al revisor varias veces y repetirlo lo convierte en
 * ruido, que es como un aviso deja de leerse.
 */
export function avisarIdentidadDeclarada(email: string): void {
  if (yaAvisado) return;
  yaAvisado = true;
  process.stderr.write(
    `aviso: --user ${email} no lo comprobó nadie — este despliegue no tiene proveedor de identidad ` +
      'configurado (AUTH_OIDC_ISSUER/AUTH_OIDC_AUDIENCE), así que el hecho queda atribuido a un ' +
      'correo DECLARADO, no autenticado.\n'
  );
}

/** Sólo para pruebas: vuelve a permitir el aviso. */
export function reiniciarAvisoDeIdentidad(): void {
  yaAvisado = false;
}
