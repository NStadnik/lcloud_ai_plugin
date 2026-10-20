import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(join(root, file), 'utf8'));
const [plugin, mcp, compat, legacyMcp, pkg, lock] = await Promise.all([
  json('plugin.json'), json('mcp.json'), json('.codex-plugin/plugin.json'), json('.mcp.json'), json('package.json'), json('package-lock.json')
]);
assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.match(plugin.name, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
for (const manifest of [compat, pkg, lock]) { assert.equal(manifest.name, plugin.name); assert.equal(manifest.version, plugin.version); }
const metadata = plugin.extensions['com.openai'].interface;
assert.equal(metadata.displayName, 'ЛКЛАУД');
assert(Array.from(metadata.shortDescription).length <= 30);
assert(Array.isArray(metadata.capabilities));
assert.equal(compat.skills, './skills/'); assert.equal(compat.mcpServers, './.mcp.json');
const definition = mcp.mcpServers.lklaud;
assert.equal(definition.type, 'stdio'); assert.equal(definition.command, 'node');
assert.equal(definition.cwd, '${PLUGIN_ROOT}');
assert.deepEqual(legacyMcp.mcpServers.lklaud.args, definition.args);
assert.equal(legacyMcp.mcpServers.lklaud.command, definition.command);
const entrypoint = resolve(definition.args[0].replace('${PLUGIN_ROOT}', root));
assert(entrypoint.startsWith(resolve(root) + '/')); await access(entrypoint);
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
for (const key of ['skills', 'mcpServers', 'apps', 'interface']) assert(!Object.hasOwn(plugin, key));
const skillText = await readFile(join(root, 'skills/lklaud/SKILL.md'), 'utf8');
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
assert(frontmatter); const skill = parse(frontmatter[1]);
assert.equal(skill.name, 'lklaud'); assert.equal(typeof skill.description, 'string'); assert(skill.description.trim());
let count = 0;
for (const directory of ['server', 'scripts', 'test']) {
  for (const file of await readdir(join(root, directory))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, directory, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${directory}/${file}: ${result.stderr}`); count++;
  }
}
console.log(`Plugin manifests, YAML, entrypoint, lockfile and ${count} JavaScript files: OK`);
