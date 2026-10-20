import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

try {
  const { values } = parseArgs({ options: {
    issuer: { type: 'string' }, resource: { type: 'string' }, output: { type: 'string' },
    'single-cloud': { type: 'boolean', default: false },
    institution: { type: 'string', multiple: true }, 'client-id': { type: 'string', default: 'lklaud-chatgpt' },
    'redirect-uri': { type: 'string' }, 'client-name': { type: 'string', default: 'ChatGPT' }
  } });
  const issuer = new URL(values.issuer); const resource = new URL(values.resource); const redirect = new URL(values['redirect-uri']);
  for (const url of [issuer, resource, redirect]) if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
  if (issuer.pathname !== '/' || issuer.search || resource.pathname !== '/mcp' || resource.search || !values.output || !isAbsolute(values.output)) throw new Error();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(values['client-id']) || !values['client-name'] || values['client-name'].length > 100) throw new Error();
  const ids = [...new Set(values.institution || [])];
  if ((values['single-cloud'] ? ids.length > 0 : !ids.length) || ids.some(id => !/^[1-9][0-9]{0,9}$/.test(id))) throw new Error();
  let exists = false; try { await access(values.output); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) { process.stderr.write('Папка вже існує; наявні OAuth-ключі не змінено.\n'); process.exit(1); }
  // Non-recursive mkdir refuses races or overwriting an existing configuration.
  await mkdir(values.output, { mode: 0o700 });
  const institutions = Object.fromEntries(ids.map(id => [id, { secret: randomBytes(32).toString('hex') }]));
  const gateway = {
    issuer: issuer.origin, resource: resource.href, encryption_key: randomBytes(32).toString('base64'),
    clients: { [values['client-id']]: { name: values['client-name'], auth_method: 'none', redirect_uris: [redirect.href], scopes: ['profile:read', 'schedule:read'] } },
    institutions
  };
  const save = (file, data) => writeFile(join(values.output, file), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (values['single-cloud']) {
    delete gateway.institutions;
    await save('single.json', gateway);
  } else await save('gateway.json', gateway);
  for (const id of ids) await save(`tenant-${id}.json`, { issuer: issuer.origin, institution_id: id, secret: institutions[id].secret });
  process.stdout.write((values['single-cloud'] ? 'Створено single.json' : 'Створено gateway.json і конфігурації закладів') + ' із правами 0600. Файли містять секрети; зберігайте папку поза document root, окремо від пакета плагіна. Значення ключів не виводилися.\n');
} catch {
  process.stderr.write('Вкажіть --issuer HTTPS_ORIGIN --resource HTTPS_MCP_URL --redirect-uri EXACT_CALLBACK (--single-cloud | --institution ID [--institution ID]) --output ABSOLUTE_NEW_DIRECTORY. Батьківська папка має існувати.\n');
  process.exitCode = 1;
}
