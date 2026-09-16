import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// A stand-in for the API: a real HTTP server on 127.0.0.1 that records what
// arrives ON THE WIRE (method, raw path, headers). What the gateway meant to
// send is not evidence; what the socket received is.
// ============================================================

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface StubApi {
  url: string;
  requests: UpstreamRequest[];
  respond: Responder;
  close(): Promise<void>;
}

export const defaultResponder: Responder = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'upstream-request-1' });
  res.end(JSON.stringify({ data: [] }));
};

export async function startStubApi(): Promise<StubApi> {
  const stub: StubApi = {
    url: '',
    requests: [],
    respond: defaultResponder,
    close: () => Promise.resolve(),
  };
  const server = http.createServer((req, res) => {
    stub.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    req.resume();
    stub.respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
