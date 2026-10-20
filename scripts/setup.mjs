#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function codexExecutable() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  return process.platform === 'darwin' && existsSync(bundled) ? bundled : 'codex';
}

export const CONNECTION_NAME = 'lklaud-user';

export function serverOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim())) throw new Error('Введіть адресу хмари (ЛКЛАУД чи Бухлік), наприклад https://lcloud.in.ua.');
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Потрібна HTTPS-адреса сервера без шляху, параметрів, логіна й пароля.');
  return url.origin;
}

async function jsonMetadata(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Сервер не повернув метадані OAuth. Перевірте адресу та налаштування users.');
  if (!response.body) throw new Error('Сервер повернув порожні метадані OAuth.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('Метадані OAuth перевищують допустимий розмір.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export async function verifyServer(origin, fetchImpl = globalThis.fetch) {
  const resource = await jsonMetadata(`${origin}/.well-known/oauth-protected-resource/mcp`, fetchImpl);
  if (resource.resource !== `${origin}/mcp` || !resource.authorization_servers?.includes(origin)) throw new Error('MCP і сервер OAuth не відповідають вибраній адресі.');
  const metadata = await jsonMetadata(`${origin}/.well-known/oauth-authorization-server`, fetchImpl);
  if (metadata.issuer !== origin || !metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('Сервер не підтримує потрібний OAuth із PKCE S256.');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    const url = new URL(metadata[field]);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new Error('Сервер повернув некоректні адреси OAuth/DCR.');
  }
}

// `codex mcp add` saves the URL and starts the native OAuth browser flow.
// Keep OAuth credentials in Codex; never return CLI output (it can contain auth URLs) to the page.
export function configureCodex(origin, { onProgress = () => {}, onChild = () => {}, cliPath = codexExecutable() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ['mcp', 'add', CONNECTION_NAME, '--url', `${origin}/mcp`, '--oauth-client-registration', 'dcr'], { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child); let output = '';
    const consume = chunk => {
      output = (output + chunk.toString()).slice(-16384);
      if (/Added global MCP server/.test(output)) onProgress('authorizing', true);
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', () => reject(new Error('Не вдалося запустити Codex CLI. Перевірте, чи він установлений.')));
    child.once('close', code => {
      onChild(null);
      if (/invalid_redirect_uri/.test(output)) reject(new Error('Адресу збережено, але сервер відхилив callback Codex (invalid_redirect_uri). Адміністратор має оновити підтримку loopback callback у users.'));
      else if (code !== 0) reject(new Error('Не вдалося завершити OAuth. Перевірте доступність сервера або повторіть підключення.'));
      else if (!/Successfully logged in/.test(output)) reject(new Error('Адресу збережено, але OAuth не завершений. Перевірте налаштування OAuth на сервері та повторіть підключення.'));
      else resolve();
    });
  });
}

export async function createSetup({ fetchImpl = globalThis.fetch, configure = configureCodex, lifetimeMs = 15 * 60_000 } = {}) {
  const csrf = randomBytes(32).toString('hex');
  const template = await readFile(new URL('../assets/setup.html', import.meta.url), 'utf8');
  let origin; let child; let timer; let closed = false;
  let state = { phase: 'idle', saved: false, server: null, message: '' };
  const send = (res, status, value, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${csrf}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(res, 403, { error: 'invalid_origin' });
      if (req.url === '/' && req.method === 'GET') return send(res, 200, template.replaceAll('__CSRF__', csrf), 'text/html; charset=utf-8');
      if (req.url === '/status' && req.method === 'GET') return send(res, 200, state);
      if (req.url !== '/configure' || req.method !== 'POST') return send(res, 404, { error: 'not_found' });
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(res, 403, { error: 'invalid_request' });
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return send(res, 413, { error: 'request_too_large' }); }
      const fields = new URLSearchParams(body); const supplied = fields.get('csrf') || '';
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(csrf) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) return send(res, 403, { error: 'invalid_csrf' });
      if (['checking', 'authorizing'].includes(state.phase)) return send(res, 409, { error: 'already_running' });
      let selected;
      try { selected = serverOrigin(fields.get('cloudUrl')); }
      catch (error) { return send(res, 400, { error: error.message }); }
      state = { phase: 'checking', saved: false, server: selected, message: '' };
      send(res, 202, state);
      void (async () => {
        try {
          await verifyServer(selected, fetchImpl);
          if (closed) return;
          await configure(selected, { onProgress: (phase, saved) => { state = { ...state, phase, saved }; }, onChild: value => { child = value; if (closed) child?.kill(); } });
          state = { ...state, phase: 'done', saved: true, message: 'Підключення готове. Поверніться до клієнта та оновіть список MCP-серверів або відкрийте новий чат.' };
        } catch (error) { state = { ...state, phase: 'error', message: error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : 'Не вдалося перевірити сервер. Перевірте адресу, мережу та налаштування OAuth у users.' }; }
      })();
    } catch { if (!res.headersSent) send(res, 400, { error: 'invalid_request' }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => { closed = true; clearTimeout(timer); child?.kill(); server.closeIdleConnections(); return new Promise(resolve => server.close(resolve)); };
  timer = setTimeout(() => { void close(); }, lifetimeMs); timer.unref();
  return { url: origin, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const setup = await createSetup();
  process.stdout.write(`Підключення хмари (ЛКЛАУД чи Бухлік): ${setup.url}\nМайстер працює 15 хвилин. Завершити: Ctrl+C.\n`);
  if (!process.argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const browser = spawn(command, [setup.url], { stdio: 'ignore' });
    browser.on('error', () => process.stderr.write('Відкрийте адресу майстра, указану вище, у браузері.\n'));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void setup.close(); });
}
