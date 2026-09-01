import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// EL GUARDIÁN DE LA URL SALIENTE (R2).
//
// Un webhook saliente es el servidor haciendo POST a una URL que escribió un
// usuario: sin guardián, esa URL puede ser 169.254.169.254 (credenciales del
// metadata endpoint), localhost (los servicios internos del propio host) o
// la red privada — SSRF de libro. La validación corre DOS veces:
//
//   · al CREAR la suscripción (sintáctica): rechaza esquemas raros, IPs
//     literales privadas y nombres obviamente internos — el error le llega
//     al humano que puede corregirlo;
//   · al ENTREGAR (resuelta): el DNS se resuelve y cada dirección se
//     verifica contra los rangos privados — cierra el nombre público que
//     apunta adentro. Queda una ventana TOCTOU entre resolver y conectar
//     (re-binding); cerrarla exige fijar la IP en el agente HTTP y se
//     anota como límite en vez de fingirse cerrada.
// ============================================================

const ESQUEMAS = new Set(['http:', 'https:']);

function ipPrivada(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||           // link-local + metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6) {
    const n = ip.toLowerCase();
    if (n === '::1' || n === '::') return true;
    if (n.startsWith('fe80') || n.startsWith('fc') || n.startsWith('fd')) return true;
    // IPv4 mapeada: ::ffff:10.0.0.1 — pero OJO: la URL de Node normaliza la
    // forma con puntos a grupos hex (::ffff:a00:1), así que se aceptan las
    // dos grafías y la hex se decodifica a sus 32 bits.
    const conPuntos = n.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (conPuntos) return ipPrivada(conPuntos[1]);
    const hex = n.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const alto = parseInt(hex[1], 16);
      const bajo = parseInt(hex[2], 16);
      return ipPrivada(`${alto >> 8}.${alto & 255}.${bajo >> 8}.${bajo & 255}`);
    }
  }
  return false;
}

const NOMBRES_INTERNOS = /(^|\.)(localhost|local|internal|localdomain)$/i;

/** Validación sintáctica, para el momento de crear la suscripción. */
export function assertUrlDeWebhook(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ValidationError(`"${url}" is not a valid URL.`);
  }
  if (!ESQUEMAS.has(u.protocol)) {
    throw new ValidationError(`Webhook URLs must be http(s); got "${u.protocol}"`);
  }
  if (u.username || u.password) {
    throw new ValidationError('Webhook URLs must not carry credentials.');
  }
  const host = u.hostname;
  if (isIP(host.replace(/^\[|\]$/g, '')) && ipPrivada(host.replace(/^\[|\]$/g, ''))) {
    throw new ValidationError(
      `"${host}" is a private/loopback/link-local address: a webhook cannot point into the server's own network.`
    );
  }
  if (NOMBRES_INTERNOS.test(host)) {
    throw new ValidationError(`"${host}" is an internal name: a webhook must point at a public endpoint.`);
  }
  return u;
}

/**
 * Validación resuelta, para el momento de entregar: el nombre se resuelve y
 * TODAS sus direcciones deben ser públicas. Lanza ValidationError si alguna
 * apunta adentro; deja pasar errores de red (el reintento normal los trata).
 */
export async function assertDestinoPublico(url: string): Promise<void> {
  const u = assertUrlDeWebhook(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return; // ya validada arriba
  let direcciones: Array<{ address: string }>;
  try {
    direcciones = await lookup(host, { all: true });
  } catch {
    // No resolver no es «apunta adentro»: se deja al fetch fallar y reintentar.
    return;
  }
  const privada = direcciones.find((d) => ipPrivada(d.address));
  if (privada) {
    throw new ValidationError(
      `"${host}" resolves to ${privada.address}, a private address: delivery refused (SSRF guard).`
    );
  }
}
