import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, verify, X509Certificate } from 'node:crypto';

// A local stand-in for the SAT Descarga Masiva authentication endpoint
// (invariant 7: the suite never calls the real SAT). It checks what the SAT
// checks — the SOAPAction, the Timestamp digest and the RSA-SHA1 signature
// against the certificate in the BinarySecurityToken — and answers with a
// token or a SOAP fault. EFIRMA-2 (#440) adds the request, verification and
// download operations on every other path: it checks the token and the
// enveloped signature and answers from a script each test sets.

const NS = 'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"';

export const SIMULATED_TOKEN = 'eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8yMDAxLzA0L3htbGRzaWctbW9yZSNobWFjLXNoYTI1NiJ9.simulated';

export function tokenResponse(created: Date, expires: Date | null, token = SIMULATED_TOKEN): string {
  const header = expires
    ? '<s:Header><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      `<u:Timestamp u:Id="_0"><u:Created>${created.toISOString()}</u:Created><u:Expires>${expires.toISOString()}</u:Expires></u:Timestamp>` +
      '</o:Security></s:Header>'
    : '';
  return (
    `<s:Envelope ${NS}>${header}<s:Body>` +
    `<AutenticaResponse xmlns="http://DescargaMasivaTerceros.gob.mx"><AutenticaResult>${token}</AutenticaResult></AutenticaResponse>` +
    '</s:Body></s:Envelope>'
  );
}

export function faultResponse(message = 'An error occurred when verifying security for the message.'): string {
  return (
    `<s:Envelope ${NS}><s:Body><s:Fault>` +
    '<faultcode xmlns:a="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">a:InvalidSecurity</faultcode>' +
    `<faultstring xml:lang="en-US">${message}</faultstring>` +
    '</s:Fault></s:Body></s:Envelope>'
  );
}

function slice(xml: string, open: string, close: string): string {
  const i = xml.indexOf(open);
  const j = xml.indexOf(close, i);
  return i < 0 || j < 0 ? '' : xml.slice(i, j + close.length);
}

function value(xml: string, tag: string): string {
  return new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '';
}

/** What the SAT checks before issuing a token. */
export function satAccepts(envelope: string, soapAction: string | undefined): boolean {
  if (soapAction !== 'http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica') return false;
  try {
    const cert = new X509Certificate(Buffer.from(value(envelope, 'o:BinarySecurityToken'), 'base64'));
    const timestamp = slice(envelope, '<u:Timestamp ', '</u:Timestamp>');
    const signedInfo = slice(envelope, '<SignedInfo ', '</SignedInfo>');
    const digest = createHash('sha1').update(timestamp).digest('base64');
    return (
      value(signedInfo, 'DigestValue') === digest &&
      verify('RSA-SHA1', Buffer.from(signedInfo), cert.publicKey, Buffer.from(value(envelope, 'SignatureValue'), 'base64'))
    );
  } catch {
    return false;
  }
}

const DES = 'http://DescargaMasivaTerceros.sat.gob.mx';

/**
 * What the SAT checks on SolicitaDescarga, VerificaSolicitudDescarga and
 * Descargar: the token, the digest of the operation element without its
 * Signature (with `des` declared on it), the RSA-SHA1 signature against the
 * certificate in X509Data, and the serial in DECIMAL.
 */
export function satAcceptsSigned(envelope: string, authorization: string | undefined): boolean {
  if (authorization !== `WRAP access_token="${SIMULATED_TOKEN}"`) return false;
  try {
    const op = /<s:Body>(<des:(\w+)>[\s\S]*<\/des:\2>)<\/s:Body>/.exec(envelope);
    if (!op) return false;
    const signature = slice(op[1], '<Signature ', '</Signature>');
    const digested = op[1].replace(signature, '').replace(`<des:${op[2]}>`, `<des:${op[2]} xmlns:des="${DES}">`);
    const signedInfo = slice(signature, '<SignedInfo ', '</SignedInfo>');
    const cert = new X509Certificate(Buffer.from(value(signature, 'X509Certificate'), 'base64'));
    return (
      value(signedInfo, 'DigestValue') === createHash('sha1').update(digested).digest('base64') &&
      value(signature, 'X509SerialNumber') === BigInt(`0x${cert.serialNumber}`).toString() &&
      verify('RSA-SHA1', Buffer.from(signedInfo), cert.publicKey, Buffer.from(value(signature, 'SignatureValue'), 'base64'))
    );
  } catch {
    return false;
  }
}

/** The answers the simulated SAT gives; tests change them per case. */
export interface SatScript {
  /** Without an id, a 5000 gets a fresh one (the SAT's ids are unique). */
  request: { code: string; id?: string };
  verify: { code: string; state: string; requestCode: string; count: number; packages: string[] };
  download: { code: string; zip: Buffer };
}

export function defaultScript(): SatScript {
  return {
    request: { code: '5000' },
    verify: { code: '5000', state: '3', requestCode: '5000', count: 2, packages: ['B1C2D3E4_01'] },
    download: { code: '5000', zip: Buffer.from('504b0304140000000800', 'hex') },
  };
}

/**
 * The SAT never hands out the XML of a cancelled received CFDI: a received XML
 * request that does not ask for Vigente only is refused with 5012 (the rule
 * phpcfdi/sat-ws-descarga-masiva's QueryValidator enforces before sending).
 */
function asksForCancelledReceivedXml(op: string, envelope: string): boolean {
  const request = /<des:solicitud [^>]*>/.exec(envelope)?.[0] ?? '';
  return op === 'SolicitaDescargaRecibidos' && request.includes('TipoSolicitud="CFDI"') &&
    !request.includes('EstadoComprobante="Vigente"');
}

function answer(action: string, envelope: string, sim: SatSimulator): string {
  const script = sim.script;
  const op = action.slice(action.lastIndexOf('/') + 1);
  let body: string;
  let header = '';
  if (op.startsWith('SolicitaDescarga')) {
    const code = asksForCancelledReceivedXml(op, envelope) ? '5012' : script.request.code;
    sim.lastRequestId = code === '5000' ? script.request.id ?? randomUUID() : undefined;
    const id = sim.lastRequestId ? ` IdSolicitud="${sim.lastRequestId}"` : '';
    body = `<${op}Response xmlns="${DES}"><${op}Result${id} RfcSolicitante="AAA010101AAA" CodEstatus="${code}" Mensaje="Simulated"/></${op}Response>`;
  } else if (op === 'VerificaSolicitudDescarga') {
    const v = script.verify;
    body =
      `<${op}Response xmlns="${DES}"><${op}Result CodEstatus="${v.code}" EstadoSolicitud="${v.state}" ` +
      `CodigoEstadoSolicitud="${v.requestCode}" NumeroCFDIs="${v.count}" Mensaje="Simulated">` +
      v.packages.map((p) => `<IdsPaquetes>${p}</IdsPaquetes>`).join('') +
      `</${op}Result></${op}Response>`;
  } else {
    header = `<s:Header><h:respuesta CodEstatus="${script.download.code}" Mensaje="Simulated" xmlns:h="${DES}"/></s:Header>`;
    body = `<RespuestaDescargaMasivaTercerosSalida xmlns="${DES}"><Paquete>${script.download.zip.toString('base64')}</Paquete></RespuestaDescargaMasivaTercerosSalida>`;
  }
  return `<s:Envelope ${NS}>${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

export interface SatSimulator {
  /** The authentication endpoint; every other path answers the download operations. */
  url: string;
  base: string;
  requests: string[];
  /** SOAPAction of every request, in order. */
  actions: string[];
  /** Forces the next answers to be a SOAP fault. */
  failing: boolean;
  script: SatScript;
  /** The IdSolicitud of the last SolicitaDescarga answer. */
  lastRequestId?: string;
  close(): Promise<void>;
}

export async function startSatSimulator(): Promise<SatSimulator> {
  const sim = { requests: [] as string[], actions: [] as string[], failing: false, script: defaultScript() } as SatSimulator;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      sim.requests.push(body);
      const header = req.headers.soapaction;
      const action = (Array.isArray(header) ? header[0] : header) ?? '';
      sim.actions.push(action);
      const auth = req.url?.startsWith('/Autenticacion');
      const ok = !sim.failing && (auth ? satAccepts(body, action) : satAcceptsSigned(body, req.headers.authorization));
      const now = new Date();
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/xml; charset=utf-8' });
      if (!ok) res.end(faultResponse());
      else res.end(auth ? tokenResponse(now, new Date(now.getTime() + 5 * 60_000)) : answer(action, body, sim));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  sim.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sim.url = `${sim.base}/Autenticacion/Autenticacion.svc`;
  sim.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return sim;
}
