import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LklaudApi } from '../server/api.mjs';
import { loadConnection } from '../server/config.mjs';
import { httpConfiguration } from '../server/http.mjs';

const cloudUrl = 'https://school.example';
const resource = 'https://mcp.example/mcp';
const token = prefix => `${prefix}_${'a'.repeat(64)}`;

test('HTTP requires the installation cloud address and rejects federated mode', () => {
  const env = { LKLAUD_CLOUD_URL: cloudUrl, LKLAUD_MCP_RESOURCE: resource };
  assert.equal(httpConfiguration(env).issuer, cloudUrl);
  assert.throws(() => httpConfiguration({ LKLAUD_MCP_RESOURCE: resource }));
  assert.throws(() => httpConfiguration({ LKLAUD_GATEWAY_URL: cloudUrl, LKLAUD_MCP_RESOURCE: resource }));
  assert.throws(() => httpConfiguration({ ...env, LKLAUD_OAUTH_MODE: 'federated' }));
  for (const url of ['http://school.example', `${cloudUrl}/path`, `${cloudUrl}?x=1`]) {
    assert.throws(() => httpConfiguration({ ...env, LKLAUD_CLOUD_URL: url }));
  }
});

test('local connection requires cloud and token together', async () => {
  await assert.rejects(loadConnection({ LKLAUD_API_TOKEN: token('lua') }));
  await assert.rejects(loadConnection({ LKLAUD_CLOUD_URL: cloudUrl }));
  assert.equal((await loadConnection({ LKLAUD_CLOUD_URL: cloudUrl, LKLAUD_API_TOKEN: token('lua') })).cloudUrl, cloudUrl);
});

for (const gateway of [false, true]) {
  test(`${gateway ? 'OAuth' : 'personal token'} sends capabilities and profile directly to configured users`, async () => {
    const calls = [];
    const api = new LklaudApi({ cloudUrl, token: token(gateway ? 'lca' : 'lua') }, {
      gateway, audience: resource,
      fetchImpl: async (url, options) => {
        calls.push(url);
        assert.equal(url.origin, cloudUrl);
        assert.equal(url.searchParams.get('do'), 'users');
        assert.equal(url.searchParams.get('func'), gateway ? 'oauth_gateway_api' : 'api');
        assert.equal(options.headers.Authorization, `Bearer ${token(gateway ? 'lca' : 'lua')}`);
        assert.equal(options.redirect, 'error');
        if (gateway) assert.equal(url.searchParams.get('audience'), resource);
        const capability = url.searchParams.get(gateway ? 'capability' : 'resource');
        const data = capability === 'capabilities' ? { version: 'v1', capabilities: [] } : { user: { id: 1, login: 'teacher' } };
        return Response.json({ st: true, data: { ...data, cloud: cloudUrl } });
      }
    });
    await api.capabilities();
    assert.equal((await api.profile()).cloud, cloudUrl);
    assert.equal(calls.length, 2);
  });
}

test('OAuth response cannot change the installation cloud', async () => {
  const api = new LklaudApi({ cloudUrl, token: token('lca') }, {
    gateway: true, audience: resource,
    fetchImpl: async () => Response.json({ st: true, data: { cloud: 'https://other.example', version: 'v1', capabilities: [] } })
  });
  await assert.rejects(api.capabilities(), { code: 'invalid_response' });
  assert.equal(api.cloudUrl, cloudUrl);
});

test('OAuth provisioning defaults to a single cloud and preserves existing keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lklaud-oauth-'));
  try {
    const output = join(directory, 'private');
    const args = ['scripts/provision-oauth.mjs', '--issuer', cloudUrl, '--resource', resource, '--redirect-uri', 'https://client.example/callback', '--output', output];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(output), ['single.json']);
    const file = join(output, 'single.json');
    const before = await readFile(file, 'utf8');
    const config = JSON.parse(before);
    assert.equal(config.issuer, cloudUrl);
    assert.equal(config.resource, resource);
    assert.equal(Object.hasOwn(config, 'institutions'), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
