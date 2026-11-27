import { describe, it, expect } from 'vitest';
import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';
import { extractFacts, relationsOf, relatedUuids } from '../../src/services/xml-ingestion/cfdi-facts.js';

// MNE-001-895 (#1073): the CFDI 4.0 schema declares CfdiRelacionados with
// maxOccurs="unbounded" (src/services/sat/cfdi40/xsd/cfd/4/cfdv40.xsd:39), and
// CfdiRelacionado inside it likewise (:45). The parser read one node: with two
// it returned an empty TipoRelacion and no UUID. Synthetic data only.

const ISSUER = 'AAA010101AAA';
const SUBSTITUTED = '22222222-2222-4222-8222-222222222222';
const ALSO_SUBSTITUTED = '44444444-4444-4444-8444-444444444444';
const ADVANCE = '33333333-3333-4333-8333-333333333333';

const node = (type: string, ...uuids: string[]) =>
  `<cfdi:CfdiRelacionados TipoRelacion="${type}">${uuids.map((u) => `<cfdi:CfdiRelacionado UUID="${u}"/>`).join('')}</cfdi:CfdiRelacionados>`;

/** A sale of 1,000.00 plus 160.00 of VAT, 1,160.00 in all, with the relation nodes given. */
const xml = (relations: string) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-01-31T12:00:00" FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN" SubTotal="1000.00" Total="1160.00" LugarExpedicion="06600" Exportacion="01">
${relations}
<cfdi:Emisor Rfc="${ISSUER}" Nombre="E" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="BBB010101BBB" Nombre="R" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" ClaveUnidad="E48" Descripcion="Servicio" Cantidad="1" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="11111111-1111-4111-8111-111111111111" FechaTimbrado="2026-01-31T12:01:00" RfcProvCertif="SAT970701NN3" SelloCFD="x" NoCertificadoSAT="1" SelloSAT="y"/></cfdi:Complemento>
</cfdi:Comprobante>`;

const parse = (relations: string) => new CFDIParser().parse(xml(relations));

describe('CFDIParser · every CfdiRelacionados node is read (cfdv40.xsd:39)', () => {
  it('no node is an empty list', () => {
    expect(parse('').cfdiRelacionados).toEqual([]);
  });

  it('one node keeps its TipoRelacion and every UUID it names', () => {
    expect(parse(node('04', SUBSTITUTED, ALSO_SUBSTITUTED)).cfdiRelacionados).toEqual([
      { tipoRelacion: '04', uuids: [SUBSTITUTED, ALSO_SUBSTITUTED] },
    ]);
  });

  it('two nodes are both returned, each with its own UUIDs, in the order of the file', () => {
    expect(parse(node('04', SUBSTITUTED) + node('07', ADVANCE)).cfdiRelacionados).toEqual([
      { tipoRelacion: '04', uuids: [SUBSTITUTED] },
      { tipoRelacion: '07', uuids: [ADVANCE] },
    ]);
  });
});

describe('CfdiFacts · the relations are a list, and its readers walk it', () => {
  const facts = (relations: string) => extractFacts(parse(relations), ISSUER);

  it('the facts carry every node', () => {
    const f = facts(node('04', SUBSTITUTED, ALSO_SUBSTITUTED) + node('07', ADVANCE));
    expect(f.relations).toEqual([
      { tipoRelacion: '04', uuids: [SUBSTITUTED, ALSO_SUBSTITUTED] },
      { tipoRelacion: '07', uuids: [ADVANCE] },
    ]);
    expect(relatedUuids(f)).toEqual([SUBSTITUTED, ALSO_SUBSTITUTED, ADVANCE]);
    expect(relatedUuids(f, '07')).toEqual([ADVANCE]);
    expect(relatedUuids(f, '01', '03')).toEqual([]);
    expect(facts('').relations).toEqual([]);
  });

  it('facts stored in the shape of one node (cfdi_classifications.facts before MNE-001-895) are read as a list of one', () => {
    const stored = { tipoRelacion: '04', uuidsRelacionados: [SUBSTITUTED] };
    expect(relationsOf(stored)).toEqual([{ tipoRelacion: '04', uuids: [SUBSTITUTED] }]);
    expect(relatedUuids(stored, '04')).toEqual([SUBSTITUTED]);
    expect(relationsOf({ uuidsRelacionados: [] })).toEqual([]);
  });
});
