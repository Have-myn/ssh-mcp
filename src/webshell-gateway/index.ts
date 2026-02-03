import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Client as SSHClient } from 'ssh2';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import {
  WebshellDb,
  WebshellTargetRow,
  SessionHistoryRow
} from './db.js';

dotenv.config();

type SSHGatewayTarget = WebshellTargetRow;

type SSHSessionInfo = {
  id: string;
  targetId: string;
  reason: string;
  createdAt: number;
};

const createDbWithRetry = async (
  maxRetries: number = 10,
  delayMs: number = 3000
): Promise<WebshellDb> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const db = await WebshellDb.create();
      return db;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to init WebshellDb');
};

const createSessionHistoryRow = (
  id: string,
  target: SSHGatewayTarget,
  reason: string
): SessionHistoryRow => {
  const now = new Date();
  return {
    id,
    targetId: target.id,
    targetName: target.name,
    host: target.host,
    port: target.port,
    username: target.username,
    startTime: now,
    endTime: null,
    status: 'connected',
    reason: reason || null
  };
};

export const startWebshellGateway = async (): Promise<void> => {
  const app = express();
  app.use(express.json());

  const MOCK_PORT = Number(process.env.MOCK_WEBSHELL_PORT || '9100');
  const PUBLIC_BASE_URL =
    process.env.WEBSHELL_PUBLIC_BASE_URL || `http://localhost:${MOCK_PORT}`;

  const db = await createDbWithRetry();
  const sessions = new Map<string, SSHSessionInfo>();

  const loadTargetOrThrow = async (id: string): Promise<SSHGatewayTarget> => {
    const target = await db.getTarget(id);
    if (!target) {
      throw new Error(`未找到目标: ${id}`);
    }
    return target;
  };

  app.get('/api/targets', async (_req, res) => {
    try {
      const list = await db.listTargets();
      res.json({ targets: list });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? '获取目标列表失败' });
    }
  });

  app.post('/api/targets', async (req, res) => {
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
      let port: number = 22;
      if (typeof portValue === 'number' && Number.isFinite(portValue)) {
        port = portValue;
      }
      const row: WebshellTargetRow = {
        id,
        host,
        port,
        username,
        password: password ?? null,
        privateKey: privateKey ?? null,
        name: name || null
      };
      const existing = await db.getTarget(id);
      if (existing) {
        await db.updateTarget(row);
      } else {
        await db.createTarget(row);
      }
      res.status(201).json({
        id,
        host,
        port,
        username,
        name: name || id
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? '创建 SSH 目标失败' });
    }
  });

  app.put('/api/targets/:id', async (req, res) => {
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
      const existing = await db.getTarget(id);
      if (!existing) {
        res.status(404).json({ error: '目标不存在' });
        return;
      }
      const updated: WebshellTargetRow = {
        id,
        host: host || existing.host,
        port:
          typeof portValue === 'number' && Number.isFinite(portValue)
            ? portValue
            : existing.port,
        username: username || existing.username,
        password:
          typeof password === 'string' ? password : existing.password ?? null,
        privateKey:
          typeof privateKey === 'string'
            ? privateKey
            : existing.privateKey ?? null,
        name: name ? name : existing.name
      };
      await db.updateTarget(updated);
      res.json({
        id,
        host: updated.host,
        port: updated.port,
        username: updated.username,
        name: updated.name || id
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? '更新 SSH 目标失败' });
    }
  });

  app.delete('/api/targets/:id', async (req, res) => {
    try {
      const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
      if (!id) {
        res.status(400).json({ error: '缺少目标 ID' });
        return;
      }
      await db.deleteTarget(id);
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? '删除 SSH 目标失败' });
    }
  });

  app.post('/api/session', async (req, res) => {
    try {
      const body = req.body || {};
      const targetId =
        body && typeof body.targetId === 'string'
          ? (body.targetId as string).trim()
          : '';
      const reason =
        body && typeof body.reason === 'string'
          ? (body.reason as string).trim()
          : '';
      if (!targetId) {
        res.status(400).json({ error: 'targetId 必须是非空字符串' });
        return;
      }
      const target = await loadTargetOrThrow(targetId);
      const id = randomUUID();
      const sessionInfo: SSHSessionInfo = {
        id,
        targetId: target.id,
        reason,
        createdAt: Date.now()
      };
      sessions.set(id, sessionInfo);
      const history = createSessionHistoryRow(id, target, reason);
      await db.createSession(history);
      const sessionUrl = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/session/${id}`;
      res.json({ sessionUrl });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? '创建 WebShell 会话失败' });
    }
  });

  app.get('/session/:id', (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id || !sessions.has(id)) {
      res.status(404).send('会话不存在或已过期');
      return;
    }
    const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>WebShell Session</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        background: #020617;
        color: #e5e7eb;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #terminal {
        height: 100%;
        width: 100%;
      }
    </style>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css"
    />
  </head>
  <body>
    <div id="terminal"></div>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script>
      (function () {
        const term = new window.Terminal({
          fontFamily: 'JetBrains Mono, Menlo, monospace',
          fontSize: 14,
          theme: {
            background: '#020617',
            foreground: '#e5e7eb'
          }
        });
        term.open(document.getElementById('terminal'));
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = proto + '//' + window.location.host + '/ws?sessionId=${id}';
        const socket = new WebSocket(wsUrl);
        socket.addEventListener('open', function () {
          term.write('\\x1b[32mConnected to remote host\\x1b[0m\\r\\n');
        });
        socket.addEventListener('message', function (event) {
          const data = event.data;
          if (typeof data === 'string') {
            term.write(data);
          }
        });
        socket.addEventListener('close', function () {
          term.write('\\r\\n\\x1b[31mConnection closed\\x1b[0m');
        });
        socket.addEventListener('error', function () {
          term.write('\\r\\n\\x1b[31mConnection error\\x1b[0m');
        });
        term.onData(function (data) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        });
      })();
    </script>
  </body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (socket, req) => {
    try {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`
      );
      const sessionId = url.searchParams.get('sessionId') || '';
      const info = sessions.get(sessionId);
      if (!info) {
        socket.close();
        return;
      }

      const target = await loadTargetOrThrow(info.targetId);
      const ssh = new SSHClient();

      ssh
        .on('ready', () => {
          ssh.shell((err, stream) => {
            if (err) {
              socket.send('打开远程 Shell 失败\\r\\n');
              socket.close();
              ssh.end();
              db
                .updateSessionEndTime(info.id, new Date(), 'error')
                .catch(() => {});
              return;
            }
            stream
              .on('data', (data: Buffer) => {
                if (socket.readyState === socket.OPEN) {
                  socket.send(data.toString('utf8'));
                }
              })
              .on('close', () => {
                if (socket.readyState === socket.OPEN) {
                  socket.close();
                }
              });
            socket.on('message', (message) => {
              if (Buffer.isBuffer(message)) {
                stream.write(message);
              } else if (typeof message === 'string') {
                stream.write(message);
              }
            });
          });
        })
        .on('error', () => {
          if (socket.readyState === socket.OPEN) {
            socket.send('连接远程主机失败\\r\\n');
            socket.close();
          }
          ssh.end();
          db
            .updateSessionEndTime(info.id, new Date(), 'error')
            .catch(() => {});
        })
        .on('close', () => {
          if (socket.readyState === socket.OPEN) {
            socket.close();
          }
        });

      ssh.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password || undefined,
        privateKey: target.privateKey || undefined
      });

      socket.on('close', () => {
        ssh.end();
        db
          .updateSessionEndTime(info.id, new Date(), 'disconnected')
          .catch(() => {});
      });
    } catch (e) {
      if (socket.readyState === socket.OPEN) {
        socket.close();
      }
    }
  });

  httpServer.listen(MOCK_PORT, () => {
    process.stdout.write(
      `SSH WebShell gateway listening on http://localhost:${MOCK_PORT}\n`
    );
  });
};
