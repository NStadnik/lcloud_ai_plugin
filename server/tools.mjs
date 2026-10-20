import { ApiError } from './api.mjs';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const empty = { type: 'object', properties: {}, additionalProperties: false };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'get_available_capabilities', title: 'Доступні можливості ЛКЛАУД',
    description: 'Перевіряє можливості підключеної хмари з урахуванням компонентів, прав користувача та дозволів токена. Не змінює дані.',
    inputSchema: empty, annotations
  },
  {
    name: 'get_my_profile', title: 'Мій профіль ЛКЛАУД',
    description: 'Показує підключений обліковий запис і хмару закладу. Особа визначається з авторизації, параметри користувача не приймаються.',
    inputSchema: empty, annotations
  },
  {
    name: 'get_my_schedule', title: 'Мій розклад ЛКЛАУД',
    description: 'Читає власний розклад підключеного облікового запису, включно з підгрупами. Дати включні, максимум 31 календарний день. Без дат — сьогодні та наступні шість днів у часовому поясі хмари. Заклад і особа визначаються з авторизації.',
    inputSchema: {
      type: 'object', properties: {
        date_from: { type: 'string', format: 'date', description: 'Перший день, YYYY-MM-DD.' },
        date_to: { type: 'string', format: 'date', description: 'Останній день включно, YYYY-MM-DD.' }
      }, additionalProperties: false
    }, annotations
  }
]);

const RESOURCE_FOR_TOOL = { get_my_profile: 'users.profile', get_my_schedule: 'rozklad.my_schedule' };
const SUPPORTED = new Set(Object.values(RESOURCE_FOR_TOOL));

export function validateArguments(name, args = {}) {
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === name);
  if (!definition) throw new ApiError('unknown_tool');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ApiError('invalid_arguments');
  const allowed = Object.keys(definition.inputSchema.properties);
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new ApiError('invalid_arguments');
  const result = {};
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError('invalid_date');
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new ApiError('invalid_date');
    result[key] = value;
  }
  if (result.date_from && result.date_to) {
    const days = (Date.parse(result.date_to) - Date.parse(result.date_from)) / 86_400_000;
    if (days < 0 || days > 30) throw new ApiError('invalid_period');
  }
  return result;
}

export class LklaudTools {
  constructor(api) { this.api = api; }
  async list() {
    const capabilities = await this.api.capabilities();
    const names = new Set(capabilities.map(item => item.name));
    return TOOL_DEFINITIONS.filter(tool => !RESOURCE_FOR_TOOL[tool.name] || names.has(RESOURCE_FOR_TOOL[tool.name]));
  }
  async call(name, args) {
    const parameters = validateArguments(name, args);
    switch (name) {
      case 'get_available_capabilities':
        return { cloud: this.api.cloudUrl, capabilities: (await this.api.capabilities()).map(item => ({ ...item, supported_by_plugin: SUPPORTED.has(item.name) })) };
      case 'get_my_profile': return this.api.profile();
      case 'get_my_schedule': return this.api.schedule(parameters);
      default: throw new ApiError('unknown_tool');
    }
  }
}
