/**
 * Resuelve el ajuste `trust proxy` de Express a partir del entorno.
 *
 * ============================================================
 * POR QUÉ ESTO NO PUEDE SER `true` A CIEGAS
 *
 * Express decide `req.ip` así: si `trust proxy` está en `false` —su omisión, y
 * lo que este repositorio tenía hasta hoy— `req.ip` es la dirección del SOCKET.
 * Detrás de un balanceador esa dirección es la del balanceador, la misma para
 * todo el mundo, así que `preAuthRateLimiter` —que reparte por IP porque antes
 * de autenticar no hay inquilino— mete a TODOS los que llaman en un solo cubo:
 * uno que abuse deja fuera a los demás. Es el único freno que tiene /public/v1,
 * que sirve sin credenciales.
 *
 * La corrección obvia sería `true`, y es PEOR que el defecto. Con `true`
 * Express se cree la cabecera `X-Forwarded-For` entera, y esa cabecera la
 * escribe quien llama: un cliente que manda una IP distinta en cada petición se
 * fabrica un cubo nuevo cada vez y el limitador deja de existir. Cambia un
 * problema de convivencia —ruidoso, visible, que se arregla con capacidad— por
 * una elusión silenciosa del único freno.
 *
 * Lo mismo vale para un número de saltos. `trust proxy = 1` significa «confía
 * en la dirección más a la derecha de la lista»; si NO hay proxy delante, esa
 * lista la compone el cliente y `1` vuelve a ser spoofing. Un número sólo es
 * correcto si el número de proxies delante es exactamente ése.
 *
 * Es decir: el valor correcto depende del DESPLIEGUE, y este archivo no puede
 * saberlo. Por eso se configura con TRUST_PROXY y el defecto es `false` — el
 * único valor que no se puede eludir. Falla hacia el cubo compartido, que es
 * ruidoso y se nota, en vez de hacia el limitador que no limita, que no se nota
 * hasta que alguien lo cuenta. En producción sin valor, avisa.
 * ============================================================
 */

/** Lo que Express acepta en `app.set('trust proxy', …)` y este módulo produce. */
export type ValorTrustProxy = boolean | number | string[];

export interface AjusteTrustProxy {
  valor: ValorTrustProxy;
  /** Advertencia para el arranque, cuando el valor elegido merece una. */
  aviso?: string;
}

/** Formas de escribir «no confíes en nadie». Se aceptan todas para que nadie
 *  ponga la cadena 'false' y acabe con la lista de un solo elemento `['false']`,
 *  que Express interpretaría como una IP y rechazaría al arrancar. */
const APAGADO = new Set(['false', '0', 'off', 'no', 'none']);

/**
 * @param crudo  valor de TRUST_PROXY tal cual viene del entorno.
 * @param env    NODE_ENV efectivo; sólo decide si la ausencia merece aviso.
 */
export function resolverTrustProxy(
  crudo: string | undefined,
  env: string = 'development'
): AjusteTrustProxy {
  const valorTexto = crudo?.trim() ?? '';

  if (valorTexto === '') {
    // Sin proxy delante esto es correcto y no hay nada que decir. Detrás de uno
    // es el cubo compartido descrito arriba, y en producción no se puede saber
    // cuál de los dos es: se dice, y quien despliega decide.
    return {
      valor: false,
      aviso:
        env === 'production'
          ? 'TRUST_PROXY is not set. If there is a load balancer or an ingress in front, ' +
            'req.ip is its address for every request and the pre-authentication limiter ' +
            'shares one single bucket among every caller. Declare the trusted hops ' +
            '(e.g. TRUST_PROXY=1) or the proxy networks (TRUST_PROXY=10.0.0.0/8). ' +
            'If the app is exposed directly, this value is the right one.'
          : undefined,
    };
  }

  if (APAGADO.has(valorTexto.toLowerCase())) return { valor: false };

  if (valorTexto.toLowerCase() === 'true') {
    return {
      valor: true,
      aviso:
        'TRUST_PROXY=true trusts the WHOLE X-Forwarded-For header, and the caller writes that ' +
        'header: it can claim a different IP on every request and get a fresh rate-limit bucket ' +
        'each time. Prefer the number of proxies in front (TRUST_PROXY=1) or their networks ' +
        '(TRUST_PROXY=10.0.0.0/8), which cannot be forged.',
    };
  }

  if (/^\d+$/.test(valorTexto)) {
    // Saltos de confianza contados desde el socket hacia atrás. Sólo es correcto
    // si coincide con los proxies REALES delante: uno de más vuelve a ser una
    // dirección que escribió el cliente.
    return { valor: Number(valorTexto) };
  }

  // Lista de direcciones, redes CIDR o nombres de proxy-addr ('loopback',
  // 'linklocal', 'uniquelocal'). Es la forma más precisa: no depende de cuántos
  // saltos haya, sino de quién es el proxy. Express valida cada entrada al
  // arrancar, así que un CIDR mal escrito se ve en el despliegue, no en la
  // primera petición.
  const lista = valorTexto.split(',').map((e) => e.trim()).filter((e) => e !== '');
  if (lista.length === 0) return { valor: false };
  return { valor: lista };
}
