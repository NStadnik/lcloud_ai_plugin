#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LklaudApi, ApiError } from './api.mjs';
import { createMcpServer } from './mcp.mjs';

export function httpConfiguration(env = process.env) {
  const issuer = new URL(env.LKLAUD_GATEWAY_URL);
  const resource = new URL(env.LKLAUD_MCP_RESOURCE);
  for (const url of [issuer, resource]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid gateway configuration');
  }
  if (issuer.pathname !== '/' || resource.pathname !== '/mcp') throw new Error('Invalid gateway configuration');
  const mode = env.LKLAUD_OAUTH_MODE || 'federated';
  if (!['federated', 'single'].includes(mode)) throw new Error('Invalid OAuth mode');
  const port = Number(env.LKLAUD_MCP_PORT || '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return { issuer: issuer.origin, resource: resource.href, host: resource.host, origin: resource.origin, port, singleCloud: mode === 'single' };
}

export function createHttpMcp(config, { fetchImpl = globalThis.fetch } = {}) {
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="Reconnect LKLAUD"`;
  const json = (res, status, data, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(data));
  };
  return createServer(async (req, res) => {
    try {
      if (req.headers.host !== config.host || (req.headers.origin && req.headers.origin !== config.origin)) return json(res, 403, { error: 'invalid_origin' });
      const path = new URL(req.url, config.origin).pathname;
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
        return json(res, 200, { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['profile:read', 'schedule:read'], bearer_methods_supported: ['header'] });
      }
      if (path !== '/mcp') return json(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      const match = /^Bearer (lca_[a-f0-9]{64})$/.exec(req.headers.authorization || '');
      if (!match) return json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': challenge });
      // A fresh resource context per HTTP request prevents cross-user/session
      // credential reuse. Authentication also checks the live tenant grant.
      const api = new LklaudApi({ cloudUrl: config.issuer, token: match[1] }, { gateway: true, singleCloud: config.singleCloud, audience: config.resource, fetchImpl });
      await api.capabilities();
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'invalid_content_type' });
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return json(res, 413, { error: 'request_too_large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const server = createMcpServer(api, { oauth: true, resourceMetadataUrl: metadataUrl });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof ApiError && [401, 403, 429].includes(error.status) ? error.status : 503;
      json(res, status, { error: status === 401 ? 'invalid_token' : 'temporarily_unavailable' }, status === 401 ? { 'WWW-Authenticate': challenge } : {});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = httpConfiguration();
    const server = createHttpMcp(config);
    server.listen(config.port, '127.0.0.1', () => process.stderr.write('ЛКЛАУД MCP HTTP: очікування reverse proxy на loopback.\n'));
    server.on('error', () => { process.stderr.write('Не вдалося запустити HTTP MCP ЛКЛАУД.\n'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); });
  } catch { process.stderr.write('Налаштуйте LKLAUD_GATEWAY_URL, LKLAUD_MCP_RESOURCE і LKLAUD_MCP_PORT.\n'); process.exitCode = 1; }
}
