// Disposable Compose acceptance only: no configurable production target.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

const api = 'http://go-api:8080';
const route = '/api/ees/connection-commands';

function request(base, method, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const outgoing = http.request(new URL(path, base), {
      method, agent: false,
      headers: { ...headers, ...(body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      }) },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error('Acceptance response exceeded limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Response aborted after headers')));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers,
            data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Acceptance HTTP timeout')));
    outgoing.end(body);
  });
}

function acknowledged(response, key) {
  assert.equal(response.status, 200);
  assert.equal(response.data.success, true);
  assert.equal(response.data.commandId, key);
  assert.ok(Number.isSafeInteger(response.data.id) && response.data.id > 0);
  return response.data.id;
}

test('TCP response loss after commit replays one connection and never resurrects it', { timeout: 60_000 }, async () => {
  let schemeId;
  let proxy;
  try {
    assert.equal((await request(api, 'GET', '/ready')).status, 200);
    const types = await request(api, 'GET', '/api/ees/component-types');
    assert.equal(types.status, 200);
    const busbar = types.data.find(type => type.code === 'busbar');
    assert.ok(busbar, 'Missing busbar fixture type');
    const scheme = await request(api, 'POST', '/api/ees/schemes', {
      name: `Command loss ${randomUUID()}`, description: 'Disposable TCP acceptance fixture',
    });
    assert.equal(scheme.status, 200);
    schemeId = scheme.data.id;
    assert.ok(Number.isSafeInteger(schemeId) && schemeId > 0);
    const components = [];
    for (const x of [0, 300]) {
      const created = await request(api, 'POST', '/api/ees/components', {
        schemeId, typeId: busbar.id, name: 'Acceptance busbar', x, y: 0, rotation: 0,
        params: { voltage_nom: '110' },
      });
      assert.equal(created.status, 200);
      assert.ok(Number.isSafeInteger(created.data.id) && created.data.id > 0);
      components.push(created.data.id);
    }
    const snapshot = async () => {
      const read = await request(api, 'GET', `/api/ees/schemes/${schemeId}`);
      assert.equal(read.status, 200);
      assert.equal(read.data.id, schemeId);
      assert.ok(Array.isArray(read.data.connections));
      return read.data.connections;
    };
    assert.equal((await snapshot()).length, 0);
    const key = randomUUID();
    const payload = { schemeId, from: components[0], to: components[1], fromPort: 'right', toPort: 'left' };
    const headers = { 'Idempotency-Key': key };
    let firstAcknowledgement;
    let proxyError;
    let dropped = 0;
    proxy = http.createServer((incoming, response) => {
      const forward = async () => {
        assert.equal(incoming.method, 'POST');
        assert.equal(incoming.url, route);
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const upstream = await request(api, 'POST', route,
          JSON.parse(Buffer.concat(chunks).toString()), { 'Idempotency-Key': incoming.headers['idempotency-key'] });
        // Reading the complete successful response proves the API committed.
        // Do not write even HTTP headers to the client on the first request.
        if (dropped === 0) {
          acknowledged(upstream, key);
          firstAcknowledgement = upstream;
          dropped++;
          response.destroy();
        } else {
          response.writeHead(upstream.status, { 'Content-Type': 'application/json',
            ...(upstream.headers['idempotency-replayed'] ? { 'Idempotency-Replayed': upstream.headers['idempotency-replayed'] } : {}) });
          response.end(JSON.stringify(upstream.data));
        }
      };
      void forward().catch(error => { proxyError = error; response.destroy(); });
    });
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const throughProxy = `http://127.0.0.1:${proxy.address().port}`;
    await assert.rejects(request(throughProxy, 'POST', route, payload, headers), error => error.code === 'ECONNRESET');
    assert.equal(proxyError, undefined);
    assert.equal(dropped, 1);
    const id = acknowledged(firstAcknowledgement, key);
    assert.deepEqual((await snapshot()).map(connection => connection.id), [id]);
    const replay = await request(throughProxy, 'POST', route, payload, headers);
    assert.equal(acknowledged(replay, key), id);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => request(throughProxy, 'POST', route, payload, headers)));
    for (const response of concurrent) assert.equal(acknowledged(response, key), id);
    assert.deepEqual((await snapshot()).map(connection => connection.id), [id]);
    assert.equal((await request(throughProxy, 'POST', route, { ...payload, fromPort: 'left' }, headers)).status, 409);
    assert.deepEqual((await snapshot()).map(connection => connection.id), [id]);
    const deletion = await request(api, 'DELETE', `/api/ees/connections/${id}`);
    assert.equal(deletion.status, 200);
    assert.equal(deletion.data.success, true);
    assert.equal((await snapshot()).length, 0);
    assert.equal(acknowledged(await request(throughProxy, 'POST', route, payload, headers), key), id);
    assert.equal((await snapshot()).length, 0, 'Replay resurrected a deleted connection');
  } finally {
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
    if (schemeId) assert.equal((await request(api, 'DELETE', `/api/ees/schemes/${schemeId}`)).status, 200);
  }
});
