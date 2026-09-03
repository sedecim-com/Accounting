import { describe, it, expect } from 'vitest';
import {
  construirPolizasXml,
  nombreDelArchivoDePolizas,
  type DatosDePolizas,
  type Poliza,
  type Transaccion,
} from '../../../src/services/sat/anexo24/polizas-xml.js';
import {
  construirAuxiliarCuentasXml,
  construirAuxiliarFoliosXml,
  nombreDelArchivoAuxiliar,
} from '../../../src/services/sat/anexo24/polizas-auxiliar-xml.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// F07d · EL ARCHIVO DE PÓLIZAS Y LOS DOS AUXILIARES.
//
// Lo que estas pruebas fijan, y lo que deliberadamente NO fijan:
//
//   SÍ · que el archivo sale SIN SELLO, siempre y por decisión: no hay
//        atributo Sello ni rama que cargue una llave privada.
//   SÍ · que los bytes son idénticos para entradas idénticas — el requisito
//        literal del catálogo de comandos.
//   SÍ · que el rastro de pago sale COMPLETO, con la cuenta origen, el banco
//        origen, la cuenta destino y el número de cheque en su nodo.
//   SÍ · que las combinaciones que la autoridad rechaza se niegan ANTES de
//        construir nada: la solicitud sin su número, el banco declarado dos
//        veces, la transferencia sin cuenta destino.
//   SÍ · que el escapado del constructor de F07b SE HEREDA: no hay un segundo
//        serializador, así que un `&` en el concepto de una póliza sale
//        escapado sin que nadie se acuerde de escaparlo.
//
//   NO · que el documento valide contra el XSD oficial. No hay ni un `.xsd` en
//        el repositorio y esta máquina no tiene red. Estas pruebas dicen lo
//        que el generador EMITE.
// ============================================================

const renglon = (over: Partial<Transaccion> = {}): Transaccion => ({
  numCta: '1120',
  desCta: 'Bancos',
  concepto: 'Pago a proveedor',
  debe: '0.00',
  haber: '1160.00',
  ...over,
});

const poliza = (over: Partial<Poliza> = {}): Poliza => ({
  numUnIdenPol: 'JE-2026-0001',
  fecha: '2026-02-10',
  concepto: 'Pago de la factura A-100',
  transacciones: [
    renglon({ numCta: '2110', desCta: 'Proveedores', debe: '1160.00', haber: '0.00' }),
    renglon(),
  ],
  ...over,
});

const datos = (over: Partial<DatosDePolizas> = {}): DatosDePolizas => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26' },
  polizas: [poliza()],
  ...over,
});

describe('el nodo raíz', () => {
  it('declara el espacio de nombres, la versión y a qué requerimiento responde', () => {
    const xml = construirPolizasXml(datos());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      'xmlns:PLZ="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo"'
    );
    expect(xml).toContain('Version="1.3"');
    expect(xml).toContain('RFC="AAA010101AAA"');
    expect(xml).toContain('Mes="02"');
    expect(xml).toContain('Anio="2026"');
    expect(xml).toContain('TipoSolicitud="AF"');
    expect(xml).toContain('NumOrden="ABC1234567/26"');
  });

  it('NO lleva sello, ni certificado, ni número de certificado', () => {
    const xml = construirPolizasXml(datos());
    expect(xml).not.toContain('Sello=');
    expect(xml).not.toContain('noCertificado=');
    expect(xml).not.toContain('Certificado=');
  });

  it('admite el mes 13, donde caen los ajustes de cierre', () => {
    expect(() => construirPolizasXml(datos({ mes: '13' }))).not.toThrow();
  });

  it('rechaza un RFC que no lo es: las pólizas las entrega un contribuyente mexicano', () => {
    expect(() => construirPolizasXml(datos({ rfc: '12-3456789' }))).toThrow(ValidationError);
  });
});

describe('la solicitud, que es la cabecera COMPARTIDA por los tres esquemas', () => {
  it('AF y FC exigen NumOrden', () => {
    expect(() => construirPolizasXml(datos({ solicitud: { tipo: 'AF' } }))).toThrow(
      /exige NumOrden/
    );
  });

  it('DE y CO exigen NumTramite', () => {
    expect(() => construirPolizasXml(datos({ solicitud: { tipo: 'DE' } }))).toThrow(
      /exige NumTramite/
    );
  });

  it('rechaza declarar orden Y trámite: son dos motivos incompatibles', () => {
    expect(() =>
      construirPolizasXml(
        datos({ solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26', numTramite: 'T-1' } })
      )
    ).toThrow(/no NumTramite/);
  });

  it('rechaza un TipoSolicitud inventado: no hay valor por omisión', () => {
    expect(() =>
      // El `as` fuerza el caso que TypeScript ya impide en el código real: lo
      // que se comprueba es que el dato llegado de una bandera de CLI —que es
      // `string`— no se cuela.
      construirPolizasXml(datos({ solicitud: { tipo: 'XX' as 'AF', numOrden: 'A' } }))
    ).toThrow(/no existe/);
  });
});

describe('el rastro de pago', () => {
  const conCheque = (): DatosDePolizas =>
    datos({
      polizas: [
        poliza({
          transacciones: [
            renglon({ numCta: '2110', desCta: 'Proveedores', debe: '1160.00', haber: '0.00' }),
            renglon({
              pagos: [
                {
                  clase: 'cheque',
                  num: '10042',
                  banEmisNal: '012',
                  ctaOri: '012180001234567895',
                  fecha: '2026-02-10',
                  benef: 'Aceros & Cía',
                  rfc: 'AAA010101AAA',
                  monto: '1160.00',
                  moneda: 'MXN',
                },
              ],
            }),
          ],
        }),
      ],
    });

  it('el cheque sale con su número, su banco emisor y su cuenta origen', () => {
    const xml = construirPolizasXml(conCheque());
    expect(xml).toContain('<PLZ:Cheque');
    expect(xml).toContain('Num="10042"');
    expect(xml).toContain('BanEmisNal="012"');
    expect(xml).toContain('CtaOri="012180001234567895"');
    expect(xml).toContain('Fecha="2026-02-10"');
    expect(xml).toContain('Monto="1160.00"');
  });

  it('EL ESCAPADO SE HEREDA DEL CONSTRUCTOR DE F07b, no se reimplementa', () => {
    // «Aceros & Cía» es un nombre de proveedor, no un caso de laboratorio, y
    // es exactamente lo que rompe una plantilla de cadena a la que se le
    // olvidó una llamada a escapeXml. Aquí no hay dónde olvidarla.
    const xml = construirPolizasXml(conCheque());
    expect(xml).toContain('Benef="Aceros &amp; Cía"');
    expect(xml).not.toContain('Benef="Aceros & Cía"');
  });

  it('la transferencia lleva origen y destino, y los cuatro campos salen en orden', () => {
    const xml = construirPolizasXml(
      datos({
        polizas: [
          poliza({
            transacciones: [
              renglon({ numCta: '2110', desCta: 'Proveedores', debe: '1160.00', haber: '0.00' }),
              renglon({
                pagos: [
                  {
                    clase: 'transferencia',
                    ctaOri: '012180001234567895',
                    bancoOriNal: '012',
                    ctaDest: '002180009876543210',
                    bancoDestNal: '002',
                    fecha: '2026-02-10',
                    benef: 'Proveedor SA',
                    rfc: 'PSA010101AA1',
                    monto: '1160.00',
                    moneda: 'MXN',
                  },
                ],
              }),
            ],
          }),
        ],
      })
    );
    const nodo = xml.split('\n').find((l) => l.includes('PLZ:Transferencia'));
    expect(nodo).toBeDefined();
    expect(nodo!.indexOf('CtaOri=')).toBeLessThan(nodo!.indexOf('BancoOriNal='));
    expect(nodo!.indexOf('BancoOriNal=')).toBeLessThan(nodo!.indexOf('CtaDest='));
    expect(nodo!.indexOf('CtaDest=')).toBeLessThan(nodo!.indexOf('BancoDestNal='));
  });

  it('rechaza una transferencia sin cuenta destino: es donde el rastro se corta', () => {
    expect(() =>
      construirPolizasXml(
        datos({
          polizas: [
            poliza({
              transacciones: [
                renglon({
                  pagos: [
                    {
                      clase: 'transferencia',
                      ctaDest: '  ',
                      fecha: '2026-02-10',
                      benef: 'X',
                      rfc: 'AAA010101AAA',
                      monto: '1160.00',
                    },
                  ],
                }),
              ],
            }),
          ],
        })
      )
    ).toThrow(/CtaDest/);
  });

  it('rechaza declarar banco nacional Y extranjero en el mismo lado', () => {
    expect(() =>
      construirPolizasXml(
        datos({
          polizas: [
            poliza({
              transacciones: [
                renglon({
                  pagos: [
                    {
                      clase: 'transferencia',
                      ctaDest: '002180009876543210',
                      bancoDestNal: '002',
                      bancoDestExt: 'Bank of Nowhere',
                      fecha: '2026-02-10',
                      benef: 'X',
                      rfc: 'AAA010101AAA',
                      monto: '1160.00',
                    },
                  ],
                }),
              ],
            }),
          ],
        })
      )
    ).toThrow(/incompatibles/);
  });

  it('exige DOS decimales en los importes: un importe del mayor no vale', () => {
    expect(() =>
      construirPolizasXml(
        datos({ polizas: [poliza({ transacciones: [renglon({ haber: '1160.0000' })] })] })
      )
    ).toThrow(/DOS decimales/);
  });
});

describe('la evidencia', () => {
  it('el CFDI nacional sale con su UUID, su RFC y su monto', () => {
    const xml = construirPolizasXml(
      datos({
        polizas: [
          poliza({
            transacciones: [
              renglon({
                numCta: '2110',
                desCta: 'Proveedores',
                debe: '1160.00',
                haber: '0.00',
                comprobantes: [
                  {
                    clase: 'nacional',
                    uuid: 'A1B2C3D4-1111-2222-3333-444455556666',
                    rfc: 'PSA010101AA1',
                    montoTotal: '1160.00',
                  },
                ],
              }),
            ],
          }),
        ],
      })
    );
    expect(xml).toContain('<PLZ:CompNal');
    expect(xml).toContain('UUID_CFDI="A1B2C3D4-1111-2222-3333-444455556666"');
    expect(xml).toContain('RFC="PSA010101AA1"');
    expect(xml).toContain('MontoTotal="1160.00"');
  });

  it('rechaza un comprobante nacional cuya contraparte no tiene RFC', () => {
    expect(() =>
      construirPolizasXml(
        datos({
          polizas: [
            poliza({
              transacciones: [
                renglon({
                  comprobantes: [
                    { clase: 'nacional', uuid: 'x', rfc: '', montoTotal: '1160.00' },
                  ],
                }),
              ],
            }),
          ],
        })
      )
    ).toThrow(/RFC/);
  });
});

describe('la coherencia del archivo', () => {
  it('rechaza un archivo sin pólizas: afirmaría que no hubo contabilidad', () => {
    expect(() => construirPolizasXml(datos({ polizas: [] }))).toThrow(/no hubo|no se registró/);
  });

  it('rechaza dos pólizas con el mismo NumUnIdenPol', () => {
    expect(() => construirPolizasXml(datos({ polizas: [poliza(), poliza()] }))).toThrow(
      /NumUnIdenPol repetido/
    );
  });

  it('rechaza una póliza sin renglones', () => {
    expect(() =>
      construirPolizasXml(datos({ polizas: [poliza({ transacciones: [] })] }))
    ).toThrow(/sin renglones|ninguna transacción/);
  });

  it('produce BYTES IDÉNTICOS para entradas idénticas', () => {
    expect(construirPolizasXml(datos())).toBe(construirPolizasXml(datos()));
  });

  it('el nombre del archivo lleva RFC, ejercicio, mes y la marca de pólizas', () => {
    expect(nombreDelArchivoDePolizas({ rfc: 'AAA010101AAA', anio: 2026, mes: '02' })).toBe(
      'AAA010101AAA202602PL.XML'
    );
  });
});

// ============================================================
// LOS DOS AUXILIARES
// ============================================================

describe('el auxiliar de folios', () => {
  const aux = () => ({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: '02',
    solicitud: { tipo: 'DE' as const, numTramite: 'T-2026-9' },
    detalles: [
      {
        numUnIdenPol: 'JE-2026-0001',
        fecha: '2026-02-10',
        comprobantes: [
          {
            clase: 'nacional' as const,
            uuid: 'A1B2C3D4-1111-2222-3333-444455556666',
            rfc: 'PSA010101AA1',
            montoTotal: '1160.00',
          },
        ],
      },
    ],
  });

  it('usa `ComprNal`, que es el nombre de ESTE esquema, no el de pólizas', () => {
    const xml = construirAuxiliarFoliosXml(aux());
    expect(xml).toContain('<RepAuxFol:ComprNal');
    expect(xml).not.toContain('CompNal');
  });

  it('comparte la cabecera de solicitud con las pólizas, con las mismas reglas', () => {
    expect(() =>
      construirAuxiliarFoliosXml({ ...aux(), solicitud: { tipo: 'DE' } })
    ).toThrow(/exige NumTramite/);
  });

  it('comparte el nodo de comprobante: el mismo dato, escapado igual', () => {
    const xml = construirAuxiliarFoliosXml(aux());
    expect(xml).toContain('UUID_CFDI="A1B2C3D4-1111-2222-3333-444455556666"');
    expect(xml).toContain('MontoTotal="1160.00"');
  });

  it('rechaza una póliza sin comprobantes: un DetAuxFol vacío no relaciona nada', () => {
    expect(() =>
      construirAuxiliarFoliosXml({
        ...aux(),
        detalles: [{ numUnIdenPol: 'JE-1', fecha: '2026-02-10', comprobantes: [] }],
      })
    ).toThrow(/sin ningún comprobante/);
  });

  it('nombra el archivo con la marca XF', () => {
    expect(nombreDelArchivoAuxiliar({ rfc: 'AAA010101AAA', anio: 2026, mes: '02' }, 'folios')).toBe(
      'AAA010101AAA202602XF.XML'
    );
  });
});

describe('el auxiliar de cuenta y subcuenta', () => {
  const aux = () => ({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: '02',
    solicitud: { tipo: 'CO' as const, numTramite: 'T-2026-4' },
    cuentas: [
      {
        numCta: '4100',
        desCta: 'Ventas',
        // Cuenta ACREEDORA: el mayor la lleva en −7 000 y el archivo la declara
        // en 7 000. La misma trampa que la balanza de F07b, aquí sobre el
        // auxiliar; el signo lo resuelve `formatearImporte`, no un abs().
        saldoIni: '7000.00',
        saldoFin: '8300.00',
        movimientos: [
          {
            fecha: '2026-02-10',
            numUnIdenPol: 'JE-2026-0002',
            concepto: 'Venta del mes',
            debe: '0.00',
            haber: '1300.00',
          },
        ],
      },
    ],
  });

  it('cada cuenta lleva su saldo inicial y final, y sus movimientos con su póliza', () => {
    const xml = construirAuxiliarCuentasXml(aux());
    expect(xml).toContain('<AuxiliarCtas:Cuenta');
    expect(xml).toContain('NumCta="4100"');
    expect(xml).toContain('SaldoIni="7000.00"');
    expect(xml).toContain('SaldoFin="8300.00"');
    expect(xml).toContain('<AuxiliarCtas:DetalleAux');
    expect(xml).toContain('NumUnIdenPol="JE-2026-0002"');
  });

  it('rechaza dos nodos Cuenta con el mismo NumCta', () => {
    const a = aux();
    expect(() =>
      construirAuxiliarCuentasXml({ ...a, cuentas: [a.cuentas[0], a.cuentas[0]] })
    ).toThrow(/NumCta repetido/);
  });

  it('nombra el archivo con la marca XC', () => {
    expect(
      nombreDelArchivoAuxiliar({ rfc: 'AAA010101AAA', anio: 2026, mes: '02' }, 'accounts')
    ).toBe('AAA010101AAA202602XC.XML');
  });
});
