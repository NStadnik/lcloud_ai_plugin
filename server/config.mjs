import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'ConfigurationError'; }
}

export function connectionFile(env = process.env) {
  return env.LKLAUD_CONFIG_FILE || join(homedir(), '.config', 'lklaud', 'connection.json');
}

export function validateConnection({ cloudUrl, token } = {}, tokenKind = 'lua') {
  let url;
  try { url = new URL(cloudUrl); } catch { throw new ConfigurationError('Вкажіть HTTPS-адресу хмари ЛКЛАУД.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConfigurationError('Адреса хмари має бути HTTPS origin, без шляху, параметрів або облікових даних.');
  }
  if (!['lua', 'lca'].includes(tokenKind) || typeof token !== 'string' || !new RegExp(`^${tokenKind}_[a-f0-9]{64}$`).test(token)) {
    throw new ConfigurationError('Потрібен персональний токен users API. Створіть його на /user/api_access та запустіть npm run configure.');
  }
  return Object.freeze({ cloudUrl: url.origin, token });
}

export async function loadConnection(env = process.env) {
  // An incomplete env override must not mix another cloud with a stored token.
  if (env.LKLAUD_CLOUD_URL !== undefined || env.LKLAUD_API_TOKEN !== undefined) {
    return validateConnection({ cloudUrl: env.LKLAUD_CLOUD_URL, token: env.LKLAUD_API_TOKEN });
  }
  let stored;
  try { stored = JSON.parse(await readFile(connectionFile(env), 'utf8')); }
  catch { throw new ConfigurationError('Підключення ЛКЛАУД не налаштовано. Запустіть npm run configure у папці плагіна.'); }
  return validateConnection(stored);
}
