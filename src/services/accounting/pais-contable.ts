// ============================================================
// «¿ESTA ENTIDAD LLEVA CONTABILIDAD MEXICANA?», EN UN SOLO SITIO
//
// La pregunta ya se contestaba en cuatro lugares y de tres formas distintas:
//
//   · iva-ppd-reclass.ts  →  incorporation_country = 'MX' OR accounting_standard = 'mx_nif'
//   · iva-cash-basis.ts   →  lee ambas columnas y decide
//   · doctor-service.ts   →  incorporation_country = 'MX', a secas
//   · chartFor(country)   →  cualquier país que no sea 'USA' es México
//
// Las cuatro coinciden en el caso normal y difieren en los bordes, que es la
// peor clase de convención: la que parece una y son varias. Aquí queda una.
//
// EL «O» NO ES REDUNDANTE. Un despacho mexicano con una filial constituida
// fuera pero cuyos libros se llevan en NIF mexicanas necesita el estrato
// fiscal mexicano aunque su país no sea MX. Y al revés: la norma contable
// puede venir vacía en datos viejos, y entonces manda el país.
//
// ANTE LA DUDA, MEXICANA. Es la regla que `chartFor` ya seguía —trata todo
// país desconocido como México— y es la segura para este producto: el motor
// es mexicano, sus reportes son mexicanos, y dejar sin estrato fiscal a una
// entidad que sí lo necesita se manifiesta como MISSING_ROLE_ACCOUNT en su
// primera factura. Sembrar cuatro cuentas de más en una entidad que no las usa
// se manifiesta como cuatro renglones en cero.
// ============================================================

/**
 * Entidad que lleva contabilidad mexicana: la que declara México como país de
 * constitución, o la que lleva sus libros en NIF mexicanas.
 *
 * Ambos argumentos son opcionales porque las dos columnas se leen de
 * `legal_entities` y una consulta puede no traer las dos. Sin ninguna de las
 * dos, la respuesta es `true` por la regla del encabezado.
 */
export function esContabilidadMexicana(
  incorporationCountry?: string | null,
  accountingStandard?: string | null
): boolean {
  if (accountingStandard === 'mx_nif') return true;
  // Sólo un país declarado y distinto de MX saca a la entidad del estrato
  // mexicano. Nulo, vacío o desconocido siguen siendo México.
  const pais = (incorporationCountry ?? '').trim().toUpperCase();
  return pais === '' || pais === 'MX';
}
