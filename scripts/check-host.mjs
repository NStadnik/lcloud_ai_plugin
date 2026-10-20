// Exercise the installed Codex parser without installing a plugin or starting OAuth.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const directory = await mkdtemp(join(tmpdir(), 'lklaud-host-'));
let processHandle;
let lines;
try {
  await mkdir(join(directory, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(directory, 'plugin'));
  for (const file of ['plugin.json', 'mcp.json']) {
    await copyFile(new URL(`../${file}`, import.meta.url), join(directory, 'plugin', file));
  }
  const marketplacePath = join(directory, '.agents', 'plugins', 'marketplace.json');
  await writeFile(marketplacePath, JSON.stringify({
    name: 'lklaud-host-check',
    plugins: [{ name: 'lklaud', source: { source: 'local', path: './plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
  }));
  processHandle = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
  lines = createInterface({ input: processHandle.stdout });
  const send = message => processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Codex parser check timed out')), 20_000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    processHandle.once('error', fail);
    processHandle.once('exit', code => fail(new Error(`Codex exited before completing the check (${code})`)));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (![1, 2].includes(message.id)) return;
        if (message.error) throw new Error(`Codex protocol error: ${message.error.code}`);
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'plugin/read', params: { marketplacePath, pluginName: 'lklaud' } });
        } else {
          // PluginReadResponse wraps the effective package in `plugin`.
          const plugin = message.result.plugin;
          assert(plugin, 'Codex returned no plugin details');
          assert.deepEqual(plugin.mcpServers, ['lklaud'], 'Codex silently skipped the MCP server');
          clearTimeout(timeout);
          resolve();
        }
      } catch (error) { fail(error); }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'lklaud-host-check', version: '1.0.0' }, capabilities: { experimentalApi: true }
    } });
  });
  console.log('Installed Codex recognizes the LKLAUD HTTP MCP server: OK');
} finally {
  lines?.close();
  if (processHandle && processHandle.exitCode === null) {
    const exited = new Promise(resolve => processHandle.once('exit', resolve));
    processHandle.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
