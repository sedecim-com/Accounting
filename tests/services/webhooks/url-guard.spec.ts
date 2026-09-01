import { describe, it, expect } from 'vitest';
import { assertUrlDeWebhook } from '../../../src/services/webhooks/url-guard.js';
import { ValidationError } from '../../../src/utils/errors.js';

/**
 * EL GUARDIÁN DE LA URL SALIENTE (R2).
 *
 * Un webhook es el servidor haciendo POST a una URL escrita por un usuario:
 * sin guardián, 169.254.169.254 devuelve credenciales del metadata endpoint
 * y localhost alcanza los servicios internos del propio host.
 */
describe('assertUrlDeWebhook', () => {
  it('acepta destinos públicos http(s)', () => {
    expect(() => assertUrlDeWebhook('https://hooks.example.com/x')).not.toThrow();
    expect(() => assertUrlDeWebhook('http://api.cliente.mx/webhook')).not.toThrow();
  });

  it.each([
    ['metadata AWS/GCP', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/'],
    ['loopback con puerto del propio servicio', 'http://127.1.2.3/v1/admin'],
    ['red privada 10/8', 'https://10.0.0.5/hook'],
    ['red privada 172.16/12', 'https://172.20.1.1/hook'],
    ['red privada 192.168/16', 'https://192.168.1.10/hook'],
    ['CGNAT', 'https://100.64.0.1/hook'],
    ['cero', 'http://0.0.0.0/'],
    ['IPv6 loopback', 'http://[::1]/hook'],
    ['IPv6 ULA', 'http://[fd12:3456::1]/hook'],
    ['IPv4 mapeada en IPv6', 'http://[::ffff:10.0.0.1]/hook'],
    ['localhost por nombre', 'http://localhost:9999/'],
    ['nombre interno', 'https://db.internal/hook'],
  ])('rechaza %s', (_caso, url) => {
    expect(() => assertUrlDeWebhook(url)).toThrow(ValidationError);
  });

  it.each([
    ['esquema ftp', 'ftp://files.example.com/x'],
    ['esquema file', 'file:///etc/passwd'],
    ['credenciales en la URL', 'https://user:pass@example.com/hook'],
    ['no-URL', 'not a url'],
  ])('rechaza %s', (_caso, url) => {
    expect(() => assertUrlDeWebhook(url)).toThrow(ValidationError);
  });
});
