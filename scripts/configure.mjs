import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionFile, validateConnection } from '../server/config.mjs';
import { LklaudApi } from '../server/api.mjs';

async function hiddenToken() {
  if (!stdin.isTTY) throw new Error('Запустіть налаштування у власному терміналі.');
  stdout.write('Персональний токен users API (введення приховано): ');
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      stdin.removeListener('data', input); stdin.setRawMode(Boolean(wasRaw)); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    }
    function input(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Налаштування скасовано.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/^[a-z0-9_]$/.test(char) && value.length < 100) value += char;
      }
    }
    stdin.on('data', input);
  });
}

let temporary;
try {
  if (!stdin.isTTY) throw new Error('Для налаштування відкрийте власний інтерактивний термінал.');
  const rl = createInterface({ input: stdin, output: stdout });
  const cloudUrl = (await rl.question('HTTPS-адреса вашої хмари ЛКЛАУД: ')).trim();
  rl.close();
  const token = await hiddenToken();
  const connection = validateConnection({ cloudUrl, token });
  const capabilities = await new LklaudApi(connection).capabilities();
  const file = connectionFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(connection, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
  await rename(temporary, file); temporary = undefined;
  stdout.write(`Підключення перевірено. Доступних можливостей: ${capabilities.length}. Налаштування збережено поза пакетом плагіна.\nПерезапустіть підключення MCP у своєму клієнті.\n`);
} catch (error) {
  if (temporary) await rm(temporary, { force: true });
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
