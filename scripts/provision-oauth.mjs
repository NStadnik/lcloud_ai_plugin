import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

try {
  const { values } = parseArgs({ options: {
    issuer: { type: 'string' }, resource: { type: 'string' }, output: { type: 'string' },
    'client-id': { type: 'string', default: 'lklaud-chatgpt' },
    'redirect-uri': { type: 'string' }, 'client-name': { type: 'string', default: 'ChatGPT' }
  } });
  const issuer = new URL(values.issuer); const resource = new URL(values.resource); const redirect = new URL(values['redirect-uri']);
  for (const url of [issuer, resource, redirect]) if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
  if (issuer.pathname !== '/' || issuer.search || resource.pathname !== '/mcp' || resource.search || !values.output || !isAbsolute(values.output)) throw new Error();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(values['client-id']) || !values['client-name'] || values['client-name'].length > 100) throw new Error();
  let exists = false; try { await access(values.output); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) { process.stderr.write('Папка вже існує; наявні OAuth-ключі не змінено.\n'); process.exit(1); }
  // Non-recursive mkdir refuses races or overwriting an existing configuration.
  await mkdir(values.output, { mode: 0o700 });
  const config = {
    issuer: issuer.origin, resource: resource.href, encryption_key: randomBytes(32).toString('base64'),
    clients: { [values['client-id']]: { name: values['client-name'], auth_method: 'none', redirect_uris: [redirect.href], scopes: ['profile:read', 'schedule:read'] } }
  };
  const save = (file, data) => writeFile(join(values.output, file), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await save('single.json', config);
  process.stdout.write('Створено single.json із правами 0600. Файл містить секрети; зберігайте папку поза document root, окремо від пакета плагіна. Значення ключів не виводилися.\n');
} catch {
  process.stderr.write('Вкажіть --issuer HTTPS_CLOUD_ORIGIN --resource HTTPS_MCP_URL --redirect-uri EXACT_CALLBACK --output ABSOLUTE_NEW_DIRECTORY. Батьківська папка має існувати.\n');
  process.exitCode = 1;
}
