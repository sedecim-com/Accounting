import { fechaEnPeriodo } from './tenant-fixture.js';

/** What a received REP needs to know about the invoice it pays. */
export interface PaidDocument {
  cfdiUuid: string;
  /** Invoice total, paid in full in one installment. */
  total: string;
  /** The invoice's transferred VAT (002 at 16 %). */
  iva: number;
}

/**
 * A CFDI 4.0 type P (Pagos 2.0) paying `doc` in full, issued by `issuerRfc`
 * to `receiverRfc` (default: the test entity). Shared by the REP linkage specs.
 * `alsoPays` adds a second related document to the same payment node, also
 * paid in full; the node's Monto is then the sum of both.
 */
export function repXml(
  doc: PaidDocument,
  repUuid: string,
  o: { issuerRfc?: string; issuerName?: string; receiverRfc?: string; date?: Date; alsoPays?: PaidDocument } = {}
): string {
  const when = (o.date ?? fechaEnPeriodo()).toISOString().slice(0, 19);
  const docs = o.alsoPays ? [doc, o.alsoPays] : [doc];
  const amount = o.alsoPays ? (Number(doc.total) + Number(o.alsoPays.total)).toFixed(2) : doc.total;
  const related = docs.map((d) => `<pago20:DoctoRelacionado IdDocumento="${d.cfdiUuid}" MonedaDR="MXN" NumParcialidad="1"
          ImpSaldoAnt="${d.total}" ImpPagado="${d.total}" ImpSaldoInsoluto="0" ObjetoImpDR="02">
          <pago20:ImpuestosDR><pago20:TrasladosDR>
            <pago20:TrasladoDR BaseDR="${(Number(d.total) - d.iva).toFixed(2)}" ImpuestoDR="002"
              TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="${d.iva.toFixed(2)}"/>
          </pago20:TrasladosDR></pago20:ImpuestosDR>
        </pago20:DoctoRelacionado>`).join('\n        ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" TipoDeComprobante="P" Moneda="XXX" Total="0" SubTotal="0"
  Fecha="${when}" LugarExpedicion="64000" Exportacion="01">
  <cfdi:Emisor Rfc="${o.issuerRfc ?? 'CCC030303CC3'}" Nombre="${o.issuerName ?? 'Proveedor REP'}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${o.receiverRfc ?? 'XAXX010101000'}" Nombre="Cliente" UsoCFDI="CP01"
    DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT"
      Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="${when}"
        FormaDePagoP="03" MonedaP="MXN" Monto="${amount}" NumOperacion="OP-9">
        ${related}
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${repUuid}"
      FechaTimbrado="${when}" SelloCFD="x" NoCertificadoSAT="1" SelloSAT="y"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}
