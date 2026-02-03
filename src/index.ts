import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { startWebshellGateway } from './webshell-gateway/index.js';

dotenv.config();

type SSHWebTerminalInput = {
  targetId?: string;
  reason?: string;
};

type SSHWebTerminalResponse = {
  sessionUrl: string;
};

type SSHWebshellTarget = {
  id: string;
  name?: string;
  host?: string;
  port?: number;
  username?: string;
};

type SSHWebshellTargetInput = {
  id: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  name?: string;
};

type RecentSession = {
  id: string;
  targetId: string;
  reason: string;
  sessionUrl: string;
  createdAt: number;
};

const SSH_WEBSHELL_API_URL = process.env.SSH_WEBSHELL_API_URL || '';
const SSH_WEBSHELL_API_TOKEN = process.env.SSH_WEBSHELL_API_TOKEN || '';
const DEFAULT_WEBSHELL_TIMEOUT_MS = Number(
  process.env.SSH_WEBSHELL_HTTP_TIMEOUT_MS ?? '15000'
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

const recentSessions: RecentSession[] = [];

const assertWebshellConfigured = () => {
  if (!SSH_WEBSHELL_API_URL) {
    throw new Error('SSH_WEBSHELL_API_URL 未配置');
  }
};

const fetchWithTimeout = async (
  url: string,
  options: any,
  timeoutMs: number = DEFAULT_WEBSHELL_TIMEOUT_MS
): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return resp;
  } catch (e: any) {
    if (e && typeof e === 'object' && (e as Error).name === 'AbortError') {
      throw new Error(
        `请求 WebShell 服务超时（${timeoutMs}ms），请检查 WebShell 服务状态`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

const fetchWebshellTargets = async (): Promise<SSHWebshellTarget[]> => {
  assertWebshellConfigured();
  const url = SSH_WEBSHELL_API_URL.replace(/\/+$/, '') + '/api/targets';
  const headers: Record<string, string> = {};
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const detail = text ? `，详情: ${text.slice(0, 200)}` : '';
    throw new Error(
      `获取目标列表失败: HTTP ${resp.status} ${resp.statusText}${detail}`
    );
  }
  const raw = (await resp.json()) as any;
  const list: SSHWebshellTarget[] = [];
  const source =
    Array.isArray(raw) ? raw : Array.isArray(raw?.targets) ? raw.targets : Array.isArray(raw?.data) ? raw.data : [];
  for (const item of source) {
    if (typeof item === 'string') {
      list.push({ id: item });
    } else if (item && typeof item === 'object') {
      const host =
        typeof (item as any).host === 'string' ? ((item as any).host as string) : undefined;
      const portValue =
        typeof (item as any).port === 'number'
          ? (item as any).port
          : typeof (item as any).port === 'string'
          ? Number((item as any).port)
          : undefined;
      const username =
        typeof (item as any).username === 'string'
          ? ((item as any).username as string)
          : undefined;
      const id =
        typeof item.id === 'string'
          ? item.id
          : typeof item.name === 'string'
          ? item.name
          : '';
      if (id) {
        const name = typeof item.name === 'string' ? item.name : undefined;
        const target: SSHWebshellTarget = { id };
        if (name) {
          target.name = name;
        }
        if (host) {
          target.host = host;
        }
        if (typeof portValue === 'number' && Number.isFinite(portValue) && portValue > 0) {
          target.port = portValue;
        }
        if (username) {
          target.username = username;
        }
        list.push(target);
      }
    }
  }
  return list;
};

const createWebshellSession = async (
  targetId: string,
  reason?: string
): Promise<SSHWebTerminalResponse> => {
  assertWebshellConfigured();
  const payload = {
    targetId,
    reason: reason || ''
  };
  const url = SSH_WEBSHELL_API_URL.replace(/\/+$/, '') + '/api/session';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `创建 WebShell 会话失败: HTTP ${resp.status} ${resp.statusText}`
    );
  }
  const data = (await resp.json()) as SSHWebTerminalResponse;
  if (!data.sessionUrl || typeof data.sessionUrl !== 'string') {
    throw new Error('WebShell 服务返回的 sessionUrl 非法');
  }
  const session: RecentSession = {
    id: randomUUID(),
    targetId,
    reason: reason || '',
    sessionUrl: data.sessionUrl,
    createdAt: Date.now()
  };
  recentSessions.unshift(session);
  if (recentSessions.length > 20) {
    recentSessions.length = 20;
  }
  return data;
};

const createWebshellTarget = async (
  input: SSHWebshellTargetInput
): Promise<void> => {
  assertWebshellConfigured();
  const url = SSH_WEBSHELL_API_URL.replace(/\/+$/, '') + '/api/targets';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const payload: any = {
    id: input.id,
    host: input.host,
    username: input.username
  };
  if (typeof input.port === 'number') {
    payload.port = input.port;
  }
  if (typeof input.password === 'string') {
    payload.password = input.password;
  }
  if (typeof input.privateKey === 'string') {
    payload.privateKey = input.privateKey;
  }
  if (typeof input.name === 'string') {
    payload.name = input.name;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const detail = text ? `，详情: ${text.slice(0, 200)}` : '';
    throw new Error(
      `创建 SSH 目标失败: HTTP ${resp.status} ${resp.statusText}${detail}`
    );
  }
};

const updateWebshellTarget = async (
  id: string,
  input: Partial<SSHWebshellTargetInput>
): Promise<void> => {
  assertWebshellConfigured();
  const safeId = id.trim();
  if (!safeId) {
    throw new Error('目标 ID 不能为空');
  }
  const url =
    SSH_WEBSHELL_API_URL.replace(/\/+$/, '') +
    '/api/targets/' +
    encodeURIComponent(safeId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const payload: any = {};
  if (typeof input.host === 'string' && input.host.trim()) {
    payload.host = input.host.trim();
  }
  if (typeof input.username === 'string' && input.username.trim()) {
    payload.username = input.username.trim();
  }
  if (typeof input.name === 'string' && input.name.trim()) {
    payload.name = input.name.trim();
  }
  if (typeof input.port === 'number' && Number.isFinite(input.port)) {
    payload.port = input.port;
  }
  if (typeof input.password === 'string') {
    payload.password = input.password;
  }
  if (typeof input.privateKey === 'string') {
    payload.privateKey = input.privateKey;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const detail = text ? `，详情: ${text.slice(0, 200)}` : '';
    throw new Error(
      `更新 SSH 目标失败: HTTP ${resp.status} ${resp.statusText}${detail}`
    );
  }
};

const deleteWebshellTarget = async (id: string): Promise<void> => {
  assertWebshellConfigured();
  const safeId = id.trim();
  if (!safeId) {
    throw new Error('目标 ID 不能为空');
  }
  const url =
    SSH_WEBSHELL_API_URL.replace(/\/+$/, '') +
    '/api/targets/' +
    encodeURIComponent(safeId);
  const headers: Record<string, string> = {};
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const detail = text ? `，详情: ${text.slice(0, 200)}` : '';
    throw new Error(
      `删除 SSH 目标失败: HTTP ${resp.status} ${resp.statusText}${detail}`
    );
  }
};

const fetchWebshellMonitor = async (id: string): Promise<any> => {
  assertWebshellConfigured();
  const safeId = id.trim();
  if (!safeId) {
    throw new Error('目标 ID 不能为空');
  }
  const url =
    SSH_WEBSHELL_API_URL.replace(/\/+$/, '') +
    '/api/monitor/' +
    encodeURIComponent(safeId);
  const headers: Record<string, string> = {};
  if (SSH_WEBSHELL_API_TOKEN) {
    headers['X-UI-Auth-Token'] = SSH_WEBSHELL_API_TOKEN;
  }
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const detail = text ? `，详情: ${text.slice(0, 200)}` : '';
    throw new Error(
      `获取监控数据失败: HTTP ${resp.status} ${resp.statusText}${detail}`
    );
  }
  return await resp.json();
};

const mcpServer = new McpServer(
  {
    name: 'ssh-webshell-mcp',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

mcpServer.registerTool(
  'create_ssh_web_terminal',
  {
    description:
      '创建一次性 WebShell 会话链接，返回可在浏览器中打开的终端 URL',
    inputSchema: {
      targetId: z
        .string()
        .describe(
          '预配置的目标 ID，例如 prod-a、jump-host-1；可选，未提供且仅有一个目标时将自动使用该目标'
        )
        .optional(),
      reason: z
        .string()
        .describe('打开会话的业务原因，用于审计')
        .optional()
    }
  },
  async ({ targetId, reason }: SSHWebTerminalInput) => {
    const safeReason = typeof reason === 'string' ? reason : '';
    let resolvedTargetId = '';

    const targets = await fetchWebshellTargets();
    if (typeof targetId === 'string' && targetId.trim()) {
      const tid = targetId.trim();
      const found = targets.find(
        (t) => t.id === tid || (typeof t.name === 'string' && t.name === tid)
      );
      if (!found) {
        const names = targets
          .map((t) => (t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id))
          .join(', ');
        throw new Error(`未找到目标: ${tid}，可用目标: ${names}`);
      }
      resolvedTargetId = found.id;
    } else {
      if (targets.length === 1) {
        resolvedTargetId = targets[0].id;
      } else if (targets.length > 1) {
        const names = targets
          .map((t) => (t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id))
          .join(', ');
        throw new Error(`targetId 必须是非空字符串，可用目标: ${names}`);
      } else {
        throw new Error('当前没有可用的 SSH 目标，请先在 SSH_TARGETS 中配置');
      }
    }

    const data = await createWebshellSession(resolvedTargetId, safeReason);
    const message =
      '已为你创建一次性 WebShell 会话链接，请在浏览器中打开:\n' +
      data.sessionUrl;

    return {
      content: [
        {
          type: 'text',
          text: message
        }
      ]
    };
  }
);

mcpServer.registerTool(
  'list_ssh_targets',
  {
    description: '以 JSON 格式列出当前可用的 SSH 目标列表，包含 targetId、名称等信息',
    inputSchema: z.object({
      requestId: z.string().optional()
    })
  },
  async (_input: { requestId?: string }) => {
    try {
      const list = await fetchWebshellTargets();
      if (!list.length) {
        const payload = {
          targets: []
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload)
            }
          ],
          structuredContent: payload
        };
      }
      const targets = list.map((t, index) => {
        const name = t.name && t.name !== t.id ? t.name : t.id;
        const host = t.host || '';
        const port =
          typeof t.port === 'number' && Number.isFinite(t.port) && t.port > 0
            ? t.port
            : 22;
        const username = t.username || '';
        return {
          index: index + 1,
          id: t.id,
          name,
          host,
          port,
          username
        };
      });
      const payload = {
        targets
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload)
          }
        ],
        structuredContent: payload
      };
    } catch (error: any) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : '获取目标列表失败';
      const payload = {
        error: `获取目标列表失败: ${message}`,
        targets: []
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload)
          }
        ],
        structuredContent: payload
      };
    }
  }
);

mcpServer.registerTool(
  'open_ssh_terminal',
  {
    description:
      '根据用户给出的目标描述自动选择 SSH 目标并创建一次性 WebShell 会话',
    inputSchema: {
      targetHint: z
        .string()
        .describe(
          '用户描述的目标，例如 "prod-a"、"8.140.200.0 生产环境"、"dev 环境那台机器"'
        ),
      reason: z
        .string()
        .describe('打开会话的业务原因，用于审计')
        .optional()
    }
  },
  async ({
    targetHint,
    reason
  }: {
    targetHint: string;
    reason?: string;
  }) => {
    const hint = typeof targetHint === 'string' ? targetHint.trim() : '';
    if (!hint) {
      throw new Error('targetHint 不能为空');
    }

    const list = await fetchWebshellTargets();
    if (!list.length) {
      throw new Error('当前没有可用的 SSH 目标，请先在 SSH_TARGETS 中配置');
    }

    const lowered = hint.toLowerCase();
    const exactMatches: SSHWebshellTarget[] = [];
    const partialMatches: SSHWebshellTarget[] = [];

    for (const t of list) {
      const idLower = t.id.toLowerCase();
      const nameLower = (t.name || '').toLowerCase();
      const isExact =
        idLower === lowered || (nameLower && nameLower === lowered);
      const isPartial =
        !isExact &&
        (idLower.includes(lowered) ||
          (nameLower && nameLower.includes(lowered)));

      if (isExact) {
        exactMatches.push(t);
      } else if (isPartial) {
        partialMatches.push(t);
      }
    }

    const candidates =
      exactMatches.length > 0 ? exactMatches : partialMatches;

    let target: SSHWebshellTarget | undefined;

    if (candidates.length === 1) {
      target = candidates[0];
    } else if (!candidates.length) {
      const names = list
        .map((t) => (t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id))
        .join(', ');
      throw new Error(`无法根据描述匹配目标，请指定更明确的名称，可用目标: ${names}`);
    } else {
      const names = candidates
        .map((t) => (t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id))
        .join(', ');
      throw new Error(`找到多个可能的目标，请更具体一些，匹配列表: ${names}`);
    }

    const safeReason = typeof reason === 'string' ? reason : '';
    const data = await createWebshellSession(target.id, safeReason);
    const displayName =
      target.name && target.name !== target.id ? `${target.name} (${target.id})` : target.id;
    const message =
      `已为你创建一次性 WebShell 会话链接（目标: ${displayName}），请在浏览器中打开:\n` +
      data.sessionUrl;

    return {
      content: [
        {
          type: 'text',
          text: message
        }
      ]
    };
  }
);

const app = express();
app.use(express.json());
app.use('/', express.static(path.join(rootDir, 'public')));

const httpStreamableTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const rawHeader = req.headers['mcp-session-id'];
    const sessionId =
      typeof rawHeader === 'string'
        ? rawHeader
        : Array.isArray(rawHeader)
        ? rawHeader[0]
        : undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
      transport = httpStreamableTransports[sessionId];
      if (!transport) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: '无效的 mcp-session-id'
          },
          id: null
        });
        return;
      }
    } else {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: '请求体必须是 JSON 对象'
          },
          id: null
        });
        return;
      }

      if (!isInitializeRequest(body as any)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: '缺少 mcp-session-id 且请求不是 initialize'
          },
          id: (body as any).id ?? null
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpStreamableTransports[newSessionId] = transport as StreamableHTTPServerTransport;
        },
        enableDnsRebindingProtection: false
      });

      transport.onclose = () => {
        const currentId = transport?.sessionId;
        if (currentId && httpStreamableTransports[currentId]) {
          delete httpStreamableTransports[currentId];
        }
      };
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    const body = req.body as any;
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: e?.message ?? 'HTTP Streamable 处理失败'
      },
      id: body && typeof body === 'object' ? body.id ?? null : null
    });
  }
});

app.post('/stream', async (req: Request, res: Response) => {
  try {
    const rawHeader = req.headers['mcp-session-id'];
    const sessionId =
      typeof rawHeader === 'string'
        ? rawHeader
        : Array.isArray(rawHeader)
        ? rawHeader[0]
        : undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
      transport = httpStreamableTransports[sessionId];
      if (!transport) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: '无效的 mcp-session-id'
          },
          id: null
        });
        return;
      }
    } else {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: '请求体必须是 JSON 对象'
          },
          id: null
        });
        return;
      }

      if (!isInitializeRequest(body as any)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: '缺少 mcp-session-id 且请求不是 initialize'
          },
          id: (body as any).id ?? null
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpStreamableTransports[newSessionId] = transport as StreamableHTTPServerTransport;
        },
        enableDnsRebindingProtection: false
      });

      transport.onclose = () => {
        const currentId = transport?.sessionId;
        if (currentId && httpStreamableTransports[currentId]) {
          delete httpStreamableTransports[currentId];
        }
      };
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    const body = req.body as any;
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: e?.message ?? 'HTTP Streamable 处理失败'
      },
      id: body && typeof body === 'object' ? body.id ?? null : null
    });
  }
});

const handleStreamableSessionRequest = async (req: Request, res: Response) => {
  const rawHeader = req.headers['mcp-session-id'];
  const sessionId =
    typeof rawHeader === 'string'
      ? rawHeader
      : Array.isArray(rawHeader)
      ? rawHeader[0]
      : undefined;

  if (!sessionId || !httpStreamableTransports[sessionId]) {
    res.status(400).send('Invalid or missing mcp-session-id');
    return;
  }

  const transport = httpStreamableTransports[sessionId];
  try {
    await transport.handleRequest(req, res);
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(500).send(e?.message ?? 'HTTP Streamable 会话处理失败');
    } else {
      res.end();
    }
  }
};

app.get('/mcp', handleStreamableSessionRequest);
app.delete('/mcp', handleStreamableSessionRequest);
app.get('/stream', handleStreamableSessionRequest);
app.delete('/stream', handleStreamableSessionRequest);

app.get('/health', (req: Request, res: Response) => {
  const uptimeMs = Math.floor(process.uptime() * 1000);
  res.json({
    ok: true,
    uptimeMs,
    timestamp: Date.now(),
    hasWebshellApiUrl: !!SSH_WEBSHELL_API_URL
  });
});

app.post('/ui/session', async (req: Request, res: Response) => {
  try {
    const { targetId, reason } = req.body || {};
    if (!targetId || typeof targetId !== 'string') {
      res.status(400).json({ error: 'targetId 必须是非空字符串' });
      return;
    }
    if (!SSH_WEBSHELL_API_URL) {
      res.status(500).json({ error: 'SSH_WEBSHELL_API_URL 未配置' });
      return;
    }
    const targets = await fetchWebshellTargets();
    const tid = targetId.trim();
    const found = targets.find(
      (t) => t.id === tid || (typeof t.name === 'string' && t.name === tid)
    );
    if (!found) {
      const names = targets
        .map((t) => (t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id))
        .join(', ');
      res.status(400).json({ error: `未找到目标: ${tid}，可用目标: ${names}` });
      return;
    }
    const data = await createWebshellSession(found.id, typeof reason === 'string' ? reason : '');
    res.json({ sessionUrl: data.sessionUrl });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '创建 WebShell 会话失败' });
  }
});

app.get('/ui/targets', async (req: Request, res: Response) => {
  try {
    const list = await fetchWebshellTargets();
    res.json({ targets: list });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '获取目标列表失败' });
  }
});

app.post('/ui/targets', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const id =
      body && typeof body.id === 'string' ? (body.id as string).trim() : '';
    const host =
      body && typeof body.host === 'string'
        ? (body.host as string).trim()
        : '';
    const username =
      body && typeof body.username === 'string'
        ? (body.username as string).trim()
        : '';
    const name =
      body && typeof body.name === 'string'
        ? (body.name as string).trim()
        : '';
    const portValue =
      body && typeof body.port === 'number'
        ? body.port
        : body && typeof body.port === 'string'
        ? Number(body.port)
        : undefined;
    const password =
      body && typeof body.password === 'string'
        ? (body.password as string)
        : undefined;
    const privateKey =
      body && typeof body.privateKey === 'string'
        ? (body.privateKey as string)
        : undefined;
    if (!id || !host || !username) {
      res.status(400).json({ error: 'id、host、username 均不能为空' });
      return;
    }
    let port: number | undefined;
    if (typeof portValue === 'number' && Number.isFinite(portValue)) {
      port = portValue;
    }
    await createWebshellTarget({
      id,
      host,
      username,
      port,
      password,
      privateKey,
      name
    });
    res.status(201).json({
      id,
      host,
      port: port ?? 22,
      username,
      name: name || id
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '创建 SSH 目标失败' });
  }
});

app.put('/ui/targets/:id', async (req: Request, res: Response) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: '缺少目标 ID' });
      return;
    }
    const body = req.body || {};
    const host =
      body && typeof body.host === 'string'
        ? (body.host as string).trim()
        : '';
    const username =
      body && typeof body.username === 'string'
        ? (body.username as string).trim()
        : '';
    const name =
      body && typeof body.name === 'string'
        ? (body.name as string).trim()
        : '';
    const portValue =
      body && typeof body.port === 'number'
        ? body.port
        : body && typeof body.port === 'string'
        ? Number(body.port)
        : undefined;
    const password =
      body && typeof body.password === 'string'
        ? (body.password as string)
        : undefined;
    const privateKey =
      body && typeof body.privateKey === 'string'
        ? (body.privateKey as string)
        : undefined;
    if (
      !host &&
      !username &&
      !name &&
      typeof portValue !== 'number' &&
      typeof password !== 'string' &&
      typeof privateKey !== 'string'
    ) {
      res.status(400).json({ error: '没有可更新的字段' });
      return;
    }
    let port: number | undefined;
    if (typeof portValue === 'number' && Number.isFinite(portValue)) {
      port = portValue;
    }
    await updateWebshellTarget(id, {
      id,
      host,
      username,
      port,
      password,
      privateKey,
      name
    });
    res.json({
      id,
      host: host || undefined,
      port: port ?? undefined,
      username: username || undefined,
      name: name || id
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '更新 SSH 目标失败' });
  }
});

app.delete('/ui/targets/:id', async (req: Request, res: Response) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: '缺少目标 ID' });
      return;
    }
    await deleteWebshellTarget(id);
    res.status(204).end();
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '删除 SSH 目标失败' });
  }
});

app.get('/ui/recent-sessions', (req: Request, res: Response) => {
  res.json({
    sessions: recentSessions
  });
});

app.get('/ui/monitor/:id', async (req: Request, res: Response) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: '缺少目标 ID' });
      return;
    }
    const data = await fetchWebshellMonitor(id);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '获取监控数据失败' });
  }
});

const port = Number(process.env.PORT ?? 3001);
const httpServer = app.listen(port, () => {
  process.stdout.write(`SSH MCP HTTP server listening on http://localhost:${port}\n`);
});

httpServer.on('error', (err) => {
  process.stderr.write(String(err instanceof Error ? err.message : err));
  process.exit(1);
});

startWebshellGateway().catch(() => {});
