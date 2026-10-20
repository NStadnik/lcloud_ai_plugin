import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createSetup, configureCodex, serverOrigin, verifyServer } from '../scripts/setup.mjs';

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

for (const [environment, customUrl, expected] of [
  ['production', '', 'https://lcloud.in.ua'], ['test', '', 'https://dev.nns.in.ua'], ['custom', 'college.example', 'https://college.example']
]) {
  test(`browser selection connects only to ${environment}`, async () => {
    const calls = [];
    const setup = await createSetup({ fetchImpl: metadata(expected), configure: async (origin, { onProgress }) => { calls.push(origin); onProgress('authorizing', true); } });
    try {
      const csrf = await form(setup);
      assert.equal((await submit(setup, csrf, { environment, customUrl })).status, 202);
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
    assert.equal((await submit(setup, csrf, { environment: 'production' }, 'https://evil.example')).status, 403);
    assert.equal((await submit(setup, 'a'.repeat(64), { environment: 'production' })).status, 403);
    assert.equal((await submit(setup, 'ї'.repeat(64), { environment: 'production' })).status, 403);
    assert.equal((await submit(setup, csrf, { environment: 'custom', customUrl: 'https://user:secret@lcloud.in.ua' })).status, 400);
    assert.equal((await submit(setup, csrf, { environment: 'unknown' })).status, 400);
    const hostStatus = await new Promise((resolve, reject) => { const req = request(setup.url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(hostStatus, 403);
    assert.equal(configured, false);
  } finally { await setup.close(); }
});

test('mismatched discovery cannot change the user connection', async () => {
  let configured = false;
  const setup = await createSetup({ fetchImpl: metadata('https://other.example'), configure: async () => { configured = true; } });
  try {
    assert.equal((await submit(setup, await form(setup), { environment: 'production' })).status, 202);
    const state = await finished(setup);
    assert.equal(state.phase, 'error'); assert.equal(state.saved, false); assert.equal(configured, false);
  } finally { await setup.close(); }
});

test('parallel submits cannot race connection changes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const setup = await createSetup({ fetchImpl: metadata('https://lcloud.in.ua'), configure: async (_, { onProgress }) => { onProgress('authorizing', true); started(); await pending; } });
  try {
    const csrf = await form(setup);
    await submit(setup, csrf, { environment: 'production' }); await running;
    assert.equal((await submit(setup, csrf, { environment: 'test' })).status, 409);
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
