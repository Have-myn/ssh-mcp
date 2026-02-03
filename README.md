# SSH MCP 服务

SSH MCP 是一个 MCP Server，用于把 WebShell 网关能力封装成 MCP 工具并通过 HTTP 提供给客户端（如 LangChain 原生 tools）。它会调用 WebShell 网关的 API 来获取目标列表与创建一次性 WebShell 会话链接。

## 功能概览

- 提供 MCP HTTP 端点：/mcp 与 /stream
- 工具能力：list_ssh_targets、create_ssh_web_terminal、open_ssh_terminal
- 通过 HTTP API 连接内联 WebShell 网关

## 架构与主要逻辑

- 进程模型：单 Node.js 进程同时承载 MCP Server 与内联 WebShell Gateway
- 数据存储：MySQL 保存 SSH 目标与会话历史记录
- 典型调用链：
  - list_ssh_targets：从 MySQL 读取目标表并返回结构化 JSON
  - create_ssh_web_terminal：在数据库中生成一次性会话记录，返回一次性 WebShell 会话链接
  - open_ssh_terminal：根据用户输入匹配 SSH 目标，复用 create_ssh_web_terminal 逻辑返回会话链接
- 网络与端口（Docker Compose 部署）：
  - mysql 服务：提供 3306 端口，ssh-mcp 容器内通过主机名 mysql 访问
  - ssh-mcp 服务：对外暴露 3001（MCP 控制台 + HTTP 端点）和 9100（WebShell 会话页）
  - 容器内部 MCP 通过 `http://localhost:9100` 调用内联 WebShell Gateway

## 项目目录结构

```
ssh-mcp/
├── .env                      # 环境变量配置
├── Dockerfile                 # Docker 镜像构建文件
├── README.md                  # 项目说明文档
├── docker-compose.yml         # Docker Compose 配置
├── package.json               # Node.js 项目配置
├── package-lock.json          # 依赖版本锁定文件
├── tsconfig.json              # TypeScript 配置
├── dist/                      # 编译输出目录
├── node_modules/              # Node.js 依赖包
├── public/                    # 公共静态资源目录
│   └── index.html
└── src/                       # 源代码目录
    ├── index.ts               # 入口文件：MCP Server 主逻辑
    └── webshell-gateway/      # 内联 WebShell Gateway 模块
        ├── index.ts           # Gateway 主逻辑（HTTP/WS 服务）
        └── db.ts              # 数据库操作（SSH 目标与会话管理）
```

**目录说明：**

| 文件/目录 | 说明 |
|-----------|------|
| `package.json` | NPM 项目配置，包含依赖和脚本命令 |
| `tsconfig.json` | TypeScript 编译配置 |
| `Dockerfile` | 用于构建 Docker 镜像 |
| `docker-compose.yml` | 用于编排 Docker 容器 |
| `.env` | 环境变量配置文件 |
| `src/` | TypeScript 源代码目录 |
| `public/` | 静态资源目录（WebShell 终端页面） |
| `dist/` | 编译后的输出目录 |

## 快速开始

### 方式一：Docker Compose（推荐，用于生产与测试环境）

在 ssh-mcp 目录执行：

```bash
docker compose up -d --build
```

该命令会启动两个容器：

- mysql：WebShell 网关使用的 MySQL 数据库
- ssh-mcp：包含 MCP Server 与内联 WebShell Gateway

默认行为与端口：

- ssh-mcp 对外暴露 3001（MCP 控制台 + /mcp、/stream 等 HTTP 端点）
- ssh-mcp 对外暴露 9100（WebShell 会话页，对应一次性会话链接）
- 容器内部 MCP 通过 `SSH_WEBSHELL_API_URL=http://localhost:9100` 调用内联 Gateway
- 容器内部访问数据库使用主机名 `mysql` 与端口 `3306`

如需调整端口或数据库账号，请编辑
[docker-compose.yml](file:///c:/Users/Administrator/Desktop/jenkins-mcp/ssh-mcp/docker-compose.yml)
或通过环境变量覆盖。

### 方式二：Docker build/run（单容器，依赖外部 MySQL）

```bash
docker build -t ssh-mcp:latest .
docker run -d \
  -p 3001:3001 \
  -e PORT=3001 \
  -e SSH_WEBSHELL_API_URL=http://localhost:9100 \
  -e MOCK_WEBSHELL_PORT=9100 \
  -e WEBSHELL_DB_HOST=<你的 MySQL 主机地址> \
  -e WEBSHELL_DB_PORT=3306 \
  -e WEBSHELL_DB_USER=webshell \
  -e WEBSHELL_DB_PASSWORD=webshell_pass \
  -e WEBSHELL_DB_DATABASE=webshell \
  --name ssh-mcp \
  ssh-mcp:latest
```

### 方式三：本地运行

```bash
npm install
npm run build
npm start
```

## 配置说明

### 服务端口

- PORT：MCP HTTP 服务端口，默认 3001

### WebShell 网关连接

- SSH_WEBSHELL_API_URL：WebShell 网关地址，默认建议为 `http://localhost:9100`
- SSH_WEBSHELL_HTTP_TIMEOUT_MS：请求超时，默认 15000
- SSH_WEBSHELL_API_TOKEN：调用 WebShell 网关受保护接口时使用的固定 API Token（内联 Gateway 当前不会强制校验，仅用于兼容旧配置）

### 内联 WebShell Gateway（已合并进 ssh-mcp）

从当前版本起，WebShell Gateway 的核心能力已经内联到 ssh-mcp 中，由同一进程启动并监听独立端口。

- MOCK_WEBSHELL_PORT：内联 WebShell Gateway HTTP/WS 端口，默认 9100
- WEBSHELL_PUBLIC_BASE_URL：会话链接对外暴露的基础地址，默认 `http://localhost:9100`

### 数据库连接（用于存储 SSH 目标与会话历史）

内联 Gateway 使用 MySQL 存储 SSH 目标和会话历史记录，对应原 WebShell Gateway 的数据结构：

- WEBSHELL_DB_HOST：数据库主机，默认 `mysql`
- WEBSHELL_DB_PORT：数据库端口，默认 `3306`
- WEBSHELL_DB_USER：数据库用户名，默认 `webshell`
- WEBSHELL_DB_PASSWORD：数据库密码，默认 `webshell_pass`
- WEBSHELL_DB_DATABASE：数据库名称，默认 `webshell`

### 数据库表结构

#### targets 表（SSH 目标）

| 字段名     | 类型            | 说明                     | 备注                           |
| ---------- | --------------- | ------------------------ | ------------------------------ |
| id         | varchar(191)    | 目标唯一 ID              | MCP 工具与 UI 侧使用此 ID 标识 |
| host       | varchar(255)    | SSH 主机地址或 IP        |                                |
| port       | int             | SSH 端口                 | 默认为 22                      |
| username   | varchar(255)    | 登录用户名               |                                |
| password   | text (nullable) | 登录密码                 | 可为空，生产建议优先用密钥认证 |
| privateKey | text (nullable) | 私钥内容（PEM）          | 可为空                          |
| name       | varchar(255)    | 目标展示名称（别名）     | 可为空                          |

索引：

- 主键：`PRIMARY KEY (id)`

#### sessions 表（SSH 会话历史 / 审计日志）

| 字段名    | 类型                                           | 说明                      | 备注                                     |
| --------- | ---------------------------------------------- | ------------------------- | ---------------------------------------- |
| id        | varchar(191)                                   | 会话 ID                   | 同时用于 `/session/:id` 链接中的 ID      |
| targetId  | varchar(191)                                   | 关联的 SSH 目标 ID        | 对应 `targets.id`                        |
| targetName| varchar(255)                                   | 目标名称冗余              | 便于审计查询                             |
| host      | varchar(255)                                   | 连接时使用的主机名或 IP   | 冗余存储，避免后续目标变更影响审计      |
| port      | int                                            | 连接时使用的端口          | 冗余存储                                 |
| username  | varchar(255)                                   | 连接时使用的账户名        | 冗余存储                                 |
| startTime | datetime                                       | 会话开始时间              | 创建会话链接时写入                       |
| endTime   | datetime (nullable)                            | 会话结束时间              | WebSocket 关闭或异常时更新               |
| status    | enum('connected','disconnected','error')       | 会话最终状态              | `connected`/`disconnected`/`error`       |
| reason    | text (nullable)                                | 创建会话时的原因说明      | 由上游调用方传入，用于审计               |

索引：

- `idx_targetId (targetId)`
- `idx_startTime (startTime)`

#### users 表（预留用户信息）

| 字段名      | 类型         | 说明               | 备注                           |
| ----------- | ------------ | ------------------ | ------------------------------ |
| id          | varchar(191) | 用户唯一 ID        |                                |
| username    | varchar(191) | 用户名             | 唯一索引                       |
| password_hash | varchar(255)| 密码哈希          | 存储加密后的口令               |
| provider    | varchar(32)  | 认证提供方标识     | 当前默认值为 `local`           |
| created_at  | datetime     | 创建时间           |                                |

索引：

- 主键：`PRIMARY KEY (id)`
- `idx_username (username)`

> 说明：当前内联 Gateway 尚未暴露基于 users 表的对外登录接口，该表为未来用户体系预留。

#### auth_sessions 表（预留认证会话）

| 字段名    | 类型         | 说明                     | 备注                                   |
| --------- | ------------ | ------------------------ | -------------------------------------- |
| token     | varchar(191) | 会话 Token（主键）       | 用于标识登录态或访问会话               |
| username  | varchar(191) | 关联的用户名             | 对应 `users.username`                  |
| provider  | varchar(32)  | 认证提供方标识           | 当前默认值为 `local`                   |
| created_at| datetime     | 会话创建时间             |                                        |
| expires_at| datetime     | 会话过期时间             | 用于失效判断和定期清理                 |

索引：

- 主键：`PRIMARY KEY (token)`
- `idx_username (username)`
- `idx_expires_at (expires_at)`

> 说明：auth_sessions 表用于记录认证会话 Token，`expires_at` 字段用于决定会话是否过期。当前代码中已提供按过期时间自动清理的能力，实际登录流程可在未来接入。

### 生产环境配置建议

- 数据库账号与密码：
  - 强烈建议在生产环境中为数据库创建独立账号，并替换默认密码
  - 建议限制数据库账号仅具备所需最小权限（最小权限原则）
- WebShell 会话访问地址：
  - 将 WEBSHELL_PUBLIC_BASE_URL 设置为经过反向代理或网关暴露的 HTTPS 域名
  - 对公网暴露时建议配合 WAF、IP 白名单等防护手段
- API 调用安全：
  - 如需在 MCP 侧做额外鉴权，可结合上层调用方实现 RBAC 或 Token 校验
  - SSH_WEBSHELL_API_TOKEN 可预留用于与外部 Gateway 集成时的签名/鉴权
- 资源与容量规划：
  - 为 MySQL 分配独立存储卷（docker-compose.yml 已默认配置）
  - 根据实际会话量评估连接数与超时配置，合理设置 SSH_WEBSHELL_HTTP_TIMEOUT_MS

## MCP 端点

- POST /mcp
- POST /stream

## 内联 WebShell Gateway 使用方式

### 1. 准备 MySQL

可以使用 Docker 启动一个 MySQL 实例（示例）：

```bash
docker run -d \
  --name webshell-mysql \
  -e MYSQL_ROOT_PASSWORD=webshell_root \
  -e MYSQL_DATABASE=webshell \
  -e MYSQL_USER=webshell \
  -e MYSQL_PASSWORD=webshell_pass \
  -p 3306:3306 \
  mysql:8.0
```

### 2. 配置 ssh-mcp 环境变量

在 ssh-mcp 目录下创建或编辑 `.env`（或通过 Docker 环境变量注入）：

```env
PORT=3001

# MCP 通过 HTTP 调用内联 Gateway
SSH_WEBSHELL_API_URL=http://localhost:9100
SSH_WEBSHELL_HTTP_TIMEOUT_MS=15000

# 内联 Gateway 监听端口与对外访问地址
MOCK_WEBSHELL_PORT=9100
WEBSHELL_PUBLIC_BASE_URL=http://localhost:9100

# MySQL 连接
WEBSHELL_DB_HOST=127.0.0.1
WEBSHELL_DB_PORT=3306
WEBSHELL_DB_USER=webshell
WEBSHELL_DB_PASSWORD=webshell_pass
WEBSHELL_DB_DATABASE=webshell
```

### 3. 启动服务并访问

```bash
cd ssh-mcp
npm install
npm run build
npm start
```

- MCP 控制台 UI：访问 `http://localhost:3001`
- 内联 WebShell Gateway 会话页：通过 MCP 工具返回的一次性会话链接，例如 `http://localhost:9100/session/<uuid>`

在 Docker Compose 场景下，默认映射为宿主机的 `http://localhost:3001` 与 `http://localhost:9100`，如修改端口请同步更新 WEBSHELL_PUBLIC_BASE_URL。

## 会话与失效策略

### WebShell SSH 会话（/session/:id）

- 会话生成：
  - MCP 工具调用内联 Gateway 的 `/api/session` 接口创建会话。
  - 内联 Gateway 为每次请求生成随机 UUID 作为 `sessionId`。
  - 会话信息写入两处：
    - 进程内内存 Map：键为 `sessionId`，值包含 `targetId`、`reason`、`createdAt` 等。
    - 数据库 `sessions` 表：写入一条会话历史记录（startTime、status、reason 等）。
- 会话访问：
  - 浏览器访问 `/session/<sessionId>` 时：
    - 如果内存 Map 中存在对应条目，则渲染 WebShell 终端页面并建立 WebSocket `/ws?sessionId=...`。
    - 如果不存在，则返回 404 文本：`会话不存在或已过期`。
- 会话结束：
  - WebSocket 正常关闭时：
    - 内联 Gateway 调用 `updateSessionEndTime`，将 `sessions` 表中的 `endTime` 更新为当前时间，`status` 置为 `disconnected`。
  - 连接远程主机出错时：
    - 会话记录的 `status` 置为 `error`，`endTime` 同样更新为当前时间。
- 失效策略（当前版本）：
  - `sessionId` 仅保存在内存 Map 中，不会被持久化用于恢复实时 SSH 通道。
  - 服务重启后内存 Map 清空，所有历史链接都会返回“会话不存在或已过期”。
  - 当前未对 `sessionId` 设置基于时间的自动 TTL 清理，在服务不重启的情况下同一链接可被多次访问。
  - 建议上层调用方将会话链接视为短期凭证，不长期缓存或下发到不可信环境。

### 认证会话（auth_sessions）

- auth_sessions 表用于保存认证会话 Token（预留能力）：
  - `token`：会话 Token 主键。
  - `username` / `provider`：标识对应用户与认证来源。
  - `expires_at`：过期时间。
- 失效判断：
  - 在读取会话时，如果 `expires_at <= 当前时间`，会被视为已过期并立刻从表中删除。
  - 提供批量清理能力，用于定期清理历史过期会话。
- 当前版本尚未对外暴露基于该表的登录接口，后续如启用认证体系，可基于此表实现登录态管理。

## 工具输出格式

### list_ssh_targets

输出为纯 JSON：

```json
{"targets":[{"index":1,"id":"prod-a","name":"prod","host":"8.140.200.0","port":22,"username":"root"}]}
```

失败时输出：

```json
{"error":"获取目标列表失败: ...","targets":[]}
```

### create_ssh_web_terminal

输出文本中包含一次性会话链接。

### open_ssh_terminal

输出文本中包含一次性会话链接，并包含匹配到的目标信息。

## 扩展方式

在 src/index.ts 中新增 MCP 工具，建议遵循以下步骤：

1. 通过 mcpServer.registerTool 定义工具名称、描述与 inputSchema
2. 在工具实现中调用 WebShell 网关 API 或其它后端服务
3. 返回结构化 JSON 或稳定格式的文本输出
4. 执行 npm run build 生成 dist

## 开发注意事项

- Node.js 版本：
  - 建议使用 Node.js 18+，以获得更好的性能与长期支持
- 本地开发：
  - 使用 `npm run dev` 以 TS 源码方式启动，默认监听 `PORT` 与内联 Gateway 端口
  - 修改 TypeScript 源码后无需手动编译，`tsx` 会实时加载
- 类型与质量检查：
  - 提交代码前建议执行 `npm run type-check` 确认类型检查无误
  - 若项目新增脚本或配置，请同步更新本文档相关章节
- 与数据库联调：
  - 本地调试时推荐使用 Docker 启动 MySQL，并通过 WEBSHELL_DB_HOST 指向容器或本机
  - 避免在生产数据库直接进行开发调试操作

## 日志与审计字段

### 会话审计（sessions 表）

`sessions` 表既承担会话历史记录，也可以作为基础的审计日志，核心字段含义如下：

- `id`：会话唯一标识，等同于 `/session/:id` 中的路径参数。
- `targetId` / `targetName`：关联的 SSH 目标 ID 和冗余名称，便于按业务目标检索。
- `host` / `port` / `username`：会话建立时实际使用的连接参数，冗余存储，避免目标后续修改影响历史数据。
- `startTime` / `endTime`：会话起止时间，可用于统计使用时长和活跃度。
- `status`：`connected` / `disconnected` / `error`，代表会话最终状态。
- `reason`：上游调用方传入的业务原因描述，例如工单号、变更单号等，建议生产环境按规范填充便于审计。

在生产环境中，可以基于 sessions 表构建报表或对接审计系统，例如统计单用户、单目标或单时间区间内的会话次数与失败率。

### UI 最近会话列表（/ui/recent-sessions）

MCP UI 通过 `/ui/recent-sessions` 接口返回内存中最近会话列表，其数据结构为：

- `id`：最近会话记录的内部 ID，与数据库 sessions 表的 `id` 不同。
- `targetId`：目标 ID，对应 `targets.id`。
- `reason`：创建会话时填写的原因。
- `sessionUrl`：内联 Gateway 返回的 WebShell 会话链接。
- `createdAt`：记录创建时间（毫秒时间戳）。

recentSessions 列表只保存在内存中，默认只保留最近 20 条记录，便于在 UI 侧快速查看最新发起的会话。

### 服务启动与错误日志（标准输出）

当前服务的日志主要通过标准输出/错误输出产生，典型包括：

- MCP HTTP 服务启动日志：
  - `SSH MCP HTTP server listening on http://localhost:<port>`
- 内联 WebShell Gateway 启动日志：
  - `SSH WebShell gateway listening on http://localhost:<MOCK_WEBSHELL_PORT>`
- HTTP Server 错误：
  - 在监听端口出错时，会将错误信息写入标准错误输出并退出进程。

生产环境中通常通过 Docker 日志、systemd 日志或容器编排平台（如 Kubernetes）集中采集上述输出，如需要更细粒度的结构化日志，可以在现有基础上引入统一的日志框架并扩展记录字段。

## 常见问题

### 端口被占用

- 启动失败并提示端口占用时：
  - 修改 PORT，或停止占用 3001 端口的进程后再启动
  - 若 Docker 场景下 3001/9100 被占用，可在 docker-compose.yml 中调整宿主机端口映射

### WebShell 网关不可达或会话链接打不开

- 检查 SSH_WEBSHELL_API_URL：
  - Docker Compose 默认在容器内使用 `http://localhost:9100`，无需修改
  - 若自行拆分 Gateway，请确保 URL 指向可访问的 HTTP 服务
- 检查会话访问地址：
  - 确认 WEBSHELL_PUBLIC_BASE_URL 与对外访问地址一致
  - 宿主机上确认 9100 端口已映射且未被防火墙拦截

### 无法连接 MySQL 或 list_ssh_targets 无返回数据

- 检查数据库连接配置：
  - 确认 WEBSHELL_DB_HOST/PORT/USER/PASSWORD/DATABASE 与实际数据库一致
  - Docker Compose 场景下应保持 WEBSHELL_DB_HOST=mysql
- 检查数据库服务状态：
  - 查看容器日志：`docker compose logs mysql`
  - 确认数据库已初始化完成且能正常接受连接
- 检查数据是否存在：
  - 登录数据库确认目标表中已写入 SSH 目标数据

### 容器反复重启

- 查看 ssh-mcp 容器日志：`docker compose logs ssh-mcp`
- 常见原因：
  - 数据库连接失败（账号密码不正确或网络不可达）
  - 环境变量缺失或配置错误
  - 宿主机资源不足导致进程被杀死

