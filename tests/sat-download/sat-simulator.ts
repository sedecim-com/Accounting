import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, verify, X509Certificate } from 'node:crypto';

// A local stand-in for the SAT Descarga Masiva authentication endpoint
// (invariant 7: the suite never calls the real SAT). It checks what the SAT
// checks — the SOAPAction, the Timestamp digest and the RSA-SHA1 signature
// against the certificate in the BinarySecurityToken — and answers with a
// token or a SOAP fault.

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

export interface SatSimulator {
  url: string;
  requests: string[];
  /** Forces the next answers to be a SOAP fault. */
  failing: boolean;
  close(): Promise<void>;
}

export async function startSatSimulator(): Promise<SatSimulator> {
  const sim = { requests: [] as string[], failing: false } as SatSimulator;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      sim.requests.push(body);
      const header = req.headers.soapaction;
      const ok = !sim.failing && satAccepts(body, Array.isArray(header) ? header[0] : header);
      const now = new Date();
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(ok ? tokenResponse(now, new Date(now.getTime() + 5 * 60_000)) : faultResponse());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  sim.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/Autenticacion/Autenticacion.svc`;
  sim.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return sim;
}
