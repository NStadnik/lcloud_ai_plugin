import { validateConnection } from './config.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MESSAGES = {
  unknown_tool: 'Цей інструмент не підтримується плагіном ЛКЛАУД.',
  invalid_arguments: 'Інструмент не приймає ці параметри. Для розкладу дозволені лише date_from та date_to.',
  authentication_required: 'Потрібна авторизація. Оновіть персональний токен через npm run configure.',
  invalid_token: 'Токен недійсний, відкликаний або прострочений. Створіть новий дозвіл у своїй хмарі та запустіть npm run configure.',
  account_inactive: 'Обліковий запис неактивний. Зверніться до адміністратора закладу.',
  access_denied: 'Для облікового запису не надано потрібних прав API.',
  api_disabled: 'Персональний API цієї хмари вимкнений.',
  capability_unavailable: 'Можливість недоступна: перевірте компонент, права облікового запису та дозволи токена.',
  rate_limit_exceeded: 'Досягнуто ліміт запитів. Повторіть пізніше.',
  api_schema_required: 'Адміністратор має застосувати оновлення бази users API.',
  invalid_period: 'Вкажіть не більше 31 календарного дня, дата завершення має бути не раніше початку.',
  invalid_date: 'Вкажіть коректну календарну дату YYYY-MM-DD.',
  api_unavailable: 'API хмари тимчасово недоступний.'
};

export class ApiError extends Error {
  constructor(code, status = 0) {
    super(MESSAGES[code] || 'Не вдалося отримати дані з хмари ЛКЛАУД.');
    this.name = 'ApiError'; this.code = code; this.status = status;
  }
}

export class LklaudApi {
  #connection; #fetch; #timeoutMs; #gateway; #audience;
  constructor(connection, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, gateway = false, audience } = {}) {
    this.#connection = validateConnection(connection, gateway ? 'lca' : 'lua');
    this.#gateway = gateway;
    if (gateway) {
      const resource = new URL(audience);
      if (resource.protocol !== 'https:' || resource.username || resource.password || resource.hash || resource.search) throw new ApiError('invalid_configuration');
      this.#audience = resource.href;
    }
    this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }
  get cloudUrl() { return this.#connection.cloudUrl; }

  async #request(resource, parameters = {}) {
    const url = new URL('/index.php', this.#connection.cloudUrl);
    url.search = new URLSearchParams(this.#gateway
      ? { ...parameters, do: 'users', func: 'oauth_gateway_api', endpoint: 'resource', capability: resource, audience: this.#audience }
      : { ...parameters, do: 'users', func: 'api', version: 'v1', resource }).toString();
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#connection.token}` },
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch { throw new ApiError('api_unavailable'); }
    if (response.status === 429) { await response.body?.cancel(); throw new ApiError('rate_limit_exceeded', 429); }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel(); throw new ApiError('invalid_response', response.status);
    }
    if (!response.body) throw new ApiError('invalid_response', response.status);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new ApiError('response_too_large', response.status); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('api_unavailable');
    } finally { reader.releaseLock(); }
    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ApiError('invalid_response', response.status); }
    if (!response.ok || envelope?.st === false) {
      const supplied = typeof envelope?.error === 'string' ? envelope.error : envelope?.error?.code;
      const code = Object.hasOwn(MESSAGES, supplied) ? supplied : response.status === 401 ? 'invalid_token' : response.status === 403 ? 'access_denied' : 'api_unavailable';
      throw new ApiError(code, response.status);
    }
    if (!envelope || typeof envelope.st !== 'boolean') throw new ApiError('invalid_response', response.status);
    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new ApiError('invalid_response', response.status);
    if (this.#gateway) {
      const origin = validateConnection({ cloudUrl: envelope.data.cloud, token: this.#connection.token }, 'lca').cloudUrl;
      if (origin !== this.#connection.cloudUrl) throw new ApiError('invalid_response', response.status);
    }
    return envelope.data;
  }

  async capabilities() {
    const data = await this.#request('capabilities');
    if (data.version !== 'v1' || !Array.isArray(data.capabilities) || data.capabilities.length > 1000) throw new ApiError('invalid_response');
    return data.capabilities.map(item => {
      if (!item || typeof item.name !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(item.name) || typeof item.scope !== 'string' || typeof item.component !== 'string' || typeof item.description !== 'string') throw new ApiError('invalid_response');
      return { name: item.name, component: item.component, scope: item.scope, description: item.description };
    });
  }
  async profile() {
    const data = await this.#request('users.profile');
    if (!data.user || !Number.isSafeInteger(data.user.id) || data.user.id < 1 || typeof data.user.login !== 'string') throw new ApiError('invalid_response');
    return { cloud: this.cloudUrl, user: { id: data.user.id, login: data.user.login } };
  }
  async schedule(parameters) {
    const data = await this.#request('rozklad.my_schedule', parameters);
    if (!Array.isArray(data.items) || data.items.length > 1000 || typeof data.timezone !== 'string' || typeof data.truncated !== 'boolean' || typeof data.date_from !== 'string' || typeof data.date_to !== 'string' || typeof data.fetched_at !== 'string') throw new ApiError('invalid_response');
    const items = data.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.id) || typeof item.date !== 'string') throw new ApiError('invalid_response');
      const result = { id: item.id, date: item.date };
      for (const name of ['lesson_number', 'group_name', 'subgroup_name', 'subject_name', 'teacher_name', 'auditorium_name', 'start_time', 'end_time']) {
        const value = item[name] ?? null;
        if (value !== null && typeof value !== 'string' && !(name === 'lesson_number' && typeof value === 'number')) throw new ApiError('invalid_response');
        result[name] = value;
      }
      return result;
    });
    return { cloud: this.cloudUrl, date_from: data.date_from, date_to: data.date_to, timezone: data.timezone, fetched_at: data.fetched_at, truncated: data.truncated, items };
  }
}
