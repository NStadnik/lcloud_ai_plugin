import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(join(root, file), 'utf8'));
const [plugin, mcp, pkg, lock] = await Promise.all([
  json('plugin.json'), json('mcp.json'), json('package.json'), json('package-lock.json')
]);
assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.match(plugin.name, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
for (const manifest of [pkg, lock]) { assert.equal(manifest.name, plugin.name); assert.equal(manifest.version, plugin.version); }
const metadata = plugin.extensions['com.openai'].interface;
assert.equal(metadata.displayName, 'ЛКЛАУД');
assert(Array.from(metadata.shortDescription).length <= 30);
assert(Array.isArray(metadata.capabilities));
// The setup wizard creates a user-scoped HTTP connection after the server is selected.
assert.deepEqual(mcp.mcpServers, {});
const marketplace = await json('.agents/plugins/marketplace.json');
assert.equal(marketplace.plugins.find(entry => entry.name === plugin.name).policy.authentication, 'ON_INSTALL');
assert.equal(plugin.extensions['com.openai'].onboardingSkill, './skills/setup/SKILL.md');
await readFile(join(root, 'assets/setup.html'), 'utf8');
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
for (const key of ['skills', 'mcpServers', 'apps', 'interface']) assert(!Object.hasOwn(plugin, key));
for (const name of await readdir(join(root, 'skills'))) {
  if (name.startsWith('.')) continue;
  const skillText = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
  assert(frontmatter); const skill = parse(frontmatter[1]);
  assert.equal(skill.name, name); assert.equal(typeof skill.description, 'string'); assert(skill.description.trim());
}
let count = 0;
for (const directory of ['server', 'scripts', 'test']) {
  for (const file of await readdir(join(root, directory))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, directory, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${directory}/${file}: ${result.stderr}`); count++;
  }
}
console.log(`Plugin manifests, server selection, onboarding, YAML, lockfile and ${count} JavaScript files: OK`);
