import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const report = { formatVersion: 1, scope: 'isolated-release-http-and-physical-reference', status: 'running', startedAt: new Date().toISOString(), checks: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'http://nginx';
let nextRequestAt = 0;
async function request(path, body, origin = base, expectedStatus = 200) {
  // This is a functional gate, not a load test. Respect nginx's 30 requests/s
  // API policy instead of consuming its burst allowance with fixture creation.
  await delay(Math.max(0, nextRequestAt - Date.now()));
  nextRequestAt = Date.now() + 50;
  const reply = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(40000) });
  if (reply.status !== expectedStatus) throw new Error(`${path}: HTTP ${reply.status}: ${(await reply.text()).slice(0, 600)}`);
  return reply;
}
async function json(path, body) { return (await request(path, body)).json(); }
function close(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}, tolerance ${tolerance}`);
}
try {
  assert.equal(process.versions.node, (await readFile('/acceptance/node-version', 'utf8')).trim());
  report.node = process.versions.node;
  report.requestPacingMs = 50;
  const referenceBytes = await readFile('/acceptance/reference.json');
  report.referenceSha256 = hash(referenceBytes);
  const fixture = JSON.parse(referenceBytes);
  assert.equal(fixture.schema_version, 1);
  report.referenceProvenance = fixture.provenance;
  const reference = fixture.compiled_transformer;
  const license = await readFile('/acceptance/LICENSE');
  for (const origin of [base, 'http://react-frontend:3000']) {
    const html = await (await request('/', undefined, origin)).text();
    assert.match(html, /id="root"/);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    assert.ok(scripts.length > 0, 'Frontend entry bundle missing');
    for (const path of scripts) {
      assert.ok(path.startsWith('/assets/'), 'Unexpected remote frontend entry');
      const asset = await request(path, undefined, origin);
      assert.match(asset.headers.get('content-type'), /javascript/);
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
    }
    const supplied = await request('/licenses/enersy-MIT.txt', undefined, origin);
    assert.equal(hash(Buffer.from(await supplied.arrayBuffer())), hash(license));
    // Both nginx configurations must forward API requests, not their SPA fallback.
    const types = await (await request('/api/ees/component-types', undefined, origin)).json();
    assert.ok(Array.isArray(types) && types.some(type => type.code === 'transformer'));
  }
  report.checks.push('frontend entry assets, MIT text and API through both proxies');
  const docs = await (await request('/guide/quickstart.html', undefined, 'http://docs')).text();
  assert.match(docs, /Docker/);
  const docsLicense = await request('/licenses/enersy-MIT.txt', undefined, 'http://docs');
  assert.equal(hash(Buffer.from(await docsLicense.arrayBuffer())), hash(license));
  report.checks.push('built documentation and MIT text');

  const types = await json('/api/ees/component-types');
  const scheme = await json('/api/ees/schemes', { name: 'Clean release independent transformer', description: 'Synthetic isolated acceptance only' });
  assert.ok(Number.isSafeInteger(scheme.id) && scheme.id > 0);
  const definitions = [
    ['generator', { voltage_nom: '110', e: '113.3', p: '0', r: '0.1', x: '0.5' }],
    ['busbar', { voltage_nom: '110' }], ['busbar', { voltage_nom: '10' }],
    ['transformer', { power_nom: '100', voltage_hv: '110', voltage_lv: '10', p_kz: '1', u_kz: '10', p_xx: '0.1', i_xx: '1' }],
    ['load', { voltage_nom: '10', p: '10', q: '3' }],
  ];
  const ids = [];
  for (const [code, params] of definitions) {
    const matches = types.filter(type => type.code === code);
    assert.equal(matches.length, 1);
    const result = await json('/api/ees/components', { schemeId: scheme.id, typeId: matches[0].id, name: code, x: 0, y: 0, rotation: 0, params });
    assert.equal(result.success, true);
    assert.ok(Number.isSafeInteger(result.id) && result.id > 0);
    ids.push(result.id);
  }
  for (const [from, to, fromPort, toPort] of [[0, 1, 'bottom', 'left'], [1, 3, 'right', 'top'], [3, 2, 'bottom', 'left'], [2, 4, 'right', 'top']]) {
    const result = await json('/api/ees/connections', { schemeId: scheme.id, from: ids[from], to: ids[to], fromPort, toPort });
    assert.equal(result.success, true);
  }
  const graph = await json(`/api/ees/schemes/${scheme.id}`);
  assert.equal(graph.components.length, 5);
  assert.equal(graph.connections.length, 4);
  report.checks.push('five objects and four connections persisted through API');
  const invalid = await request(`/api/ees/calculate/${scheme.id}`, {}, base, 400);
  assert.ok(typeof (await invalid.json()).error === 'string');
  report.checks.push('malformed operating limit body rejected before calculation');
  const result = await json(`/api/ees/calculate/${scheme.id}`, { operatingLimits: [] });
  assert.equal(result.success, true);
  for (let i = 0; i < 3; i++) {
    const matches = result.nodes.filter(node => node.members.includes(ids[i]) && node.is_internal_source_node === (i === 0));
    assert.equal(matches.length, 1);
    const node = matches[0];
    close(node.voltage_pu, reference.expected.v_pu[i], 1e-8, `Node ${i} V p.u.`);
    close(node.angle_rad, reference.expected.theta_rad[i], 1e-8, `Node ${i} angle rad`);
    close(node.p_mw / 100, reference.expected.p_pu[i], 1e-8, `Node ${i} P p.u.`);
    close(node.q_mvar / 100, reference.expected.q_pu[i], 1e-8, `Node ${i} Q p.u.`);
  }
  for (let i = 0; i < 2; i++) {
    const matches = result.branches.filter(branch => branch.component_id === ids[i === 0 ? 0 : 3]);
    assert.equal(matches.length, 1);
    const expected = [...reference.expected.branch_mw_mvar[i]];
    if (i === 1) {
      // PYPOWER puts magnetization on the HV bus; compare the same physical boundary.
      expected[0] += reference.expected.v_pu[1] ** 2 * reference.bus[1][4];
      expected[1] -= reference.expected.v_pu[1] ** 2 * reference.bus[1][5];
    }
    ['p_from_mw', 'q_from_mvar', 'p_to_mw', 'q_to_mvar'].forEach((key, k) => close(matches[0][key], expected[k], 1e-6, `Branch ${i} ${key} MW/Mvar`));
  }
  report.checks.push('real Julia AC result against PYPOWER transformer reference');
  report.tolerances = { voltagePU: 1e-8, angleRad: 1e-8, powerPU: 1e-8, branchMWMvar: 1e-6 };
  const removed = await fetch(`${base}/api/ees/schemes/${scheme.id}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).success, true);
  report.checks.push('synthetic fixture deleted');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error).slice(0, 5000);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile('/reports/http-physical.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
