import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createSetup, configureCodex, serverOrigin, verifyServer, verifyCodexMcp } from '../scripts/setup.mjs';

const metadata = origin => async url => Response.json(url.endsWith('/oauth-authorization-server') ? {
  issuer: origin, code_challenge_methods_supported: ['S256'],
  authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`
} : { resource: `${origin}/mcp`, authorization_servers: [origin] });
async function form(setup) {
  const html = await (await fetch(setup.url)).text();
  return /name="csrf" value="([a-f0-9]+)"/.exec(html)[1];
}
const submit = (setup, csrf, fields, origin = setup.url) => fetch(`${setup.url}/configure`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf, ...fields })
});
async function finished(setup) {
  for (let count = 0; count < 100; count++) {
    const state = await (await fetch(`${setup.url}/status`)).json();
    if (['done', 'error'].includes(state.phase)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Setup did not finish');
}

test('server addresses become a canonical HTTPS origin', () => {
  assert.equal(serverOrigin(' lcloud.in.ua '), 'https://lcloud.in.ua');
  assert.equal(serverOrigin('https://DEV.NNS.IN.UA/'), 'https://dev.nns.in.ua');
  assert.equal(serverOrigin('https://college.example:8443'), 'https://college.example:8443');
  for (const input of ['', 'http://lcloud.in.ua', 'https://user:password@lcloud.in.ua', 'https://lcloud.in.ua/mcp', 'https://lcloud.in.ua/?token=abc', 'https://lcloud.in.ua/#x', 'lcloud.in.ua\n--command', 'https://lcloud.in.ua/../mcp']) {
    assert.throws(() => serverOrigin(input), input);
  }
});

for (const [cloudUrl, expected] of [
  ['lcloud.in.ua', 'https://lcloud.in.ua'], ['https://dev.nns.in.ua/', 'https://dev.nns.in.ua'], ['college.example', 'https://college.example']
]) {
  test(`browser URL input connects only to ${expected}`, async () => {
    const calls = [];
    const setup = await createSetup({ fetchImpl: metadata(expected), verifyMcp: async () => {}, configure: async (origin, { onProgress }) => { calls.push(origin); onProgress('authorizing', true); } });
    try {
      const csrf = await form(setup);
      assert.equal((await submit(setup, csrf, { cloudUrl })).status, 202);
      const state = await finished(setup);
      assert.equal(state.phase, 'done'); assert.equal(state.server, expected); assert.equal(state.saved, true);
      assert.deepEqual(calls, [expected]);
    } finally { await setup.close(); }
  });
}

test('untrusted form submissions and invalid addresses never configure Codex', async () => {
  let configured = false;
  const setup = await createSetup({ configure: async () => { configured = true; } });
  try {
    const csrf = await form(setup);
    assert.equal((await submit(setup, csrf, { cloudUrl: 'lcloud.in.ua' }, 'https://evil.example')).status, 403);
    assert.equal((await submit(setup, 'a'.repeat(64), { cloudUrl: 'lcloud.in.ua' })).status, 403);
    assert.equal((await submit(setup, 'ї'.repeat(64), { cloudUrl: 'lcloud.in.ua' })).status, 403);
    assert.equal((await submit(setup, csrf, { cloudUrl: 'https://user:secret@lcloud.in.ua' })).status, 400);
    assert.equal((await submit(setup, csrf, {})).status, 400);
    const hostStatus = await new Promise((resolve, reject) => { const req = request(setup.url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(hostStatus, 403);
    assert.equal(configured, false);
  } finally { await setup.close(); }
});

test('mismatched discovery cannot change the user connection', async () => {
  let configured = false;
  const setup = await createSetup({ fetchImpl: metadata('https://other.example'), configure: async () => { configured = true; } });
  try {
    assert.equal((await submit(setup, await form(setup), { cloudUrl: 'lcloud.in.ua' })).status, 202);
    const state = await finished(setup);
    assert.equal(state.phase, 'error'); assert.equal(state.saved, false); assert.equal(configured, false);
  } finally { await setup.close(); }
});

test('parallel submits cannot race connection changes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const setup = await createSetup({ fetchImpl: metadata('https://lcloud.in.ua'), verifyMcp: async () => {}, configure: async (_, { onProgress }) => { onProgress('authorizing', true); started(); await pending; } });
  try {
    const csrf = await form(setup);
    await submit(setup, csrf, { cloudUrl: 'lcloud.in.ua' }); await running;
    assert.equal((await submit(setup, csrf, { cloudUrl: 'dev.nns.in.ua' })).status, 409);
    release(); assert.equal((await finished(setup)).server, 'https://lcloud.in.ua');
  } finally { release(); await setup.close(); }
});

test('discovery must support PKCE and same-origin OAuth endpoints', async () => {
  for (const change of [{ code_challenge_methods_supported: ['plain'] }, { token_endpoint: 'https://other.example/token' }, { registration_endpoint: null }]) {
    await assert.rejects(verifyServer('https://lcloud.in.ua', async url => {
      const response = await metadata('https://lcloud.in.ua')(url);
      return url.endsWith('/oauth-authorization-server') ? Response.json({ ...await response.json(), ...change }) : response;
    }));
  }
});

test('native CLI receives the selected MCP URL as a separate argument', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lklaud-cli-test-'));
  try {
    const cliPath = join(directory, 'codex-fixture');
    await writeFile(cliPath, '#!/usr/bin/env node\nconsole.log("Added global MCP server lklaud-user."); console.log("Successfully logged in.");\n', { mode: 0o700 });
    let args; let saved = false;
    await configureCodex('https://dev.nns.in.ua', { cliPath, onChild: child => { if (child) args = child.spawnargs.slice(1); }, onProgress: (_, value) => { saved = value; } });
    assert.deepEqual(args, ['mcp', 'add', 'lklaud-user', '--url', 'https://dev.nns.in.ua/mcp', '--oauth-client-registration', 'dcr']);
    assert.equal(saved, true);
    await writeFile(cliPath, '#!/usr/bin/env node\nconsole.error("invalid_redirect_uri https://example.test/?secret=hidden"); process.exit(1);\n', { mode: 0o700 });
    await assert.rejects(configureCodex('https://dev.nns.in.ua', { cliPath }), error => /invalid_redirect_uri/.test(error.message) && !error.message.includes('hidden'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OAuth success stays pending until MCP verification succeeds and blocks parallel submissions', async () => {
  let release; let started;
  const pending = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const calls = [];
  const setup = await createSetup({ fetchImpl: metadata('https://lcloud.in.ua'),
    configure: async () => { calls.push('oauth'); },
    verifyMcp: async origin => { calls.push(origin); started(); await pending; }
  });
  try {
    const csrf = await form(setup);
    await submit(setup, csrf, { cloudUrl: 'lcloud.in.ua' }); await running;
    const state = await (await fetch(`${setup.url}/status`)).json();
    assert.equal(state.phase, 'verifying'); assert.equal(state.saved, true);
    assert(!state.message.includes('Підключення готове'));
    assert.equal((await submit(setup, csrf, { cloudUrl: 'dev.nns.in.ua' })).status, 409);
    assert.deepEqual(calls, ['oauth', 'https://lcloud.in.ua']);
    release(); assert.equal((await finished(setup)).phase, 'done');
  } finally { release(); await setup.close(); }
});

test('MCP failure after OAuth preserves the saved state without claiming success', async () => {
  const setup = await createSetup({ fetchImpl: metadata('https://lcloud.in.ua'), configure: async () => {},
    verifyMcp: async () => { throw new Error('OAuth завершено, але не вдалося отримати список інструментів (tools/list).'); }
  });
  try {
    await submit(setup, await form(setup), { cloudUrl: 'lcloud.in.ua' });
    const state = await finished(setup);
    assert.equal(state.phase, 'error'); assert.equal(state.saved, true);
    assert.match(state.message, /tools\/list/); assert(!state.message.includes('Підключення готове'));
  } finally { await setup.close(); }
});

test('native MCP verification checks initialize and tools/list results, hides diagnostics, and times out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lklaud-mcp-cli-test-'));
  const status = { name: 'lklaud-user', httpOrigin: 'https://dev.nns.in.ua', serverInfo: { name: 'fixture', version: '1' }, serverCapabilities: { tools: {} }, tools: {}, toolsError: null };
  const cliPath = join(directory, 'codex-fixture');
  const fixture = async body => writeFile(cliPath, `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(1);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 1 && m.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
  if (m.id === 2) {
    if(m.method !== 'mcpServerStatus/list' || m.params.serverName !== 'lklaud-user' || m.params.detail !== 'toolsAndAuthOnly') process.exit(1);
    ${body}
  }
});
`, { mode: 0o700 });
  try {
    // Empty tools are a valid successful catalog, not a transport failure.
    await fixture(`console.log(JSON.stringify({id:2,result:{data:[${JSON.stringify(status)}]}}));`);
    await verifyCodexMcp('https://dev.nns.in.ua', { cliPath });
    for (const [change, pattern] of [
      [{ serverInfo: null }, /initialize/], [{ httpOrigin: 'https://other.example' }, /initialize/],
      [{ toolsError: 'HTTP 500 secret_token https://server.example' }, /tools\/list/],
      [{ toolsError: undefined }, /tools\/list/], [{ tools: null }, /tools\/list/]
    ]) {
      await fixture(`console.log(JSON.stringify({id:2,result:{data:[${JSON.stringify({ ...status, ...change })}]}}));`);
      await assert.rejects(verifyCodexMcp('https://dev.nns.in.ua', { cliPath }), error => pattern.test(error.message) && !/secret_token|https:/.test(error.message));
    }
    await fixture('console.log(JSON.stringify({id:2,error:{code:-1,message:"secret_token https://server.example"}}));');
    await assert.rejects(verifyCodexMcp('https://dev.nns.in.ua', { cliPath }), error => !/secret_token|https:/.test(error.message));
    await fixture('process.exit(0);');
    await assert.rejects(verifyCodexMcp('https://dev.nns.in.ua', { cliPath }), /без підтвердження/);
    await fixture('');
    await assert.rejects(verifyCodexMcp('https://dev.nns.in.ua', { cliPath, timeoutMs: 500 }), /час очікування/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
