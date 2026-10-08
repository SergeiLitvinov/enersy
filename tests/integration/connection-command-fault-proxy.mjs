// Browser acceptance only. Never deploy as an application ingress.
// Serves the real frontend and forwards the real API; drops the first successful
// acknowledgement per UUID after reading the API's complete committed response.
import http from 'node:http';

const dropped = new Set();
const inFlight = new Set();
const commandRoute = '/api/ees/connection-commands';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const server = http.createServer((incoming, response) => {
  if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
    response.writeHead(400);
    response.end();
    return;
  }
  if (incoming.method === 'GET' && incoming.url === '/__acceptance/ready') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready', dropped: dropped.size }));
    return;
  }
  const target = new URL(incoming.url, incoming.url.startsWith('/api/') ? 'http://go-api:8080' : 'http://react-frontend:3000');
  const key = incoming.headers['idempotency-key'];
  const canonical = typeof key === 'string' ? key.toLowerCase() : '';
  const fault = incoming.method === 'POST' && incoming.url === commandRoute && uuid.test(canonical) &&
    !dropped.has(canonical) && !inFlight.has(canonical);
  if (fault) inFlight.add(canonical);
  const upstream = http.request(target, {
    method: incoming.method, headers: { ...incoming.headers, host: target.host }, agent: false,
  }, committed => {
    if (!fault) {
      response.writeHead(committed.statusCode, committed.headers);
      committed.pipe(response);
      committed.on('error', () => response.destroy());
      return;
    }
    const chunks = [];
    let size = 0;
    committed.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) committed.destroy(new Error('Fault acknowledgement exceeded limit'));
      else chunks.push(chunk);
    });
    committed.on('error', () => { inFlight.delete(canonical); response.destroy(); });
    committed.on('end', () => {
      inFlight.delete(canonical);
      const body = Buffer.concat(chunks);
      let acknowledgement;
      try { acknowledgement = JSON.parse(body.toString()); } catch { /* Forward invalid responses unchanged. */ }
      if (committed.statusCode === 200 && acknowledgement?.success === true &&
          acknowledgement.commandId === canonical && Number.isSafeInteger(acknowledgement.id) && acknowledgement.id > 0) {
        dropped.add(canonical);
        console.log(JSON.stringify({ event: 'committed-ack-dropped', commandId: canonical, connectionId: acknowledgement.id }));
        // No headers/body have reached the browser. Nginx is not between this
        // socket and the browser, so it cannot turn the loss into a 502 response.
        response.destroy();
      } else {
        response.writeHead(committed.statusCode, committed.headers);
        response.end(body);
      }
    });
  });
  upstream.setTimeout(40_000, () => upstream.destroy(new Error('Acceptance upstream timeout')));
  upstream.on('error', () => {
    inFlight.delete(canonical);
    if (response.destroyed) return;
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  incoming.on('error', () => upstream.destroy());
  incoming.pipe(upstream);
});
server.requestTimeout = 45_000;
server.listen(3001, '0.0.0.0');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
