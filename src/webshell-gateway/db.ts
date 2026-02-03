import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

export type WebshellTargetRow = {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string | null;
  privateKey: string | null;
  name: string | null;
};

export type SessionHistoryRow = {
  id: string;
  targetId: string;
  targetName: string | null;
  host: string;
  port: number;
  username: string;
  startTime: Date;
  endTime: Date | null;
  status: 'connected' | 'disconnected' | 'error';
  reason: string | null;
};

export type AuthUserRow = {
  id: string;
  username: string;
  passwordHash: string;
  provider: 'local';
  createdAt: Date;
};

export type AuthSessionRow = {
  token: string;
  username: string;
  provider: string;
  createdAt: Date;
  expiresAt: Date;
};

export class WebshellDb {
  private pool: mysql.Pool;

  private constructor(pool: mysql.Pool) {
    this.pool = pool;
  }

  static async create(): Promise<WebshellDb> {
    const host = process.env.WEBSHELL_DB_HOST || 'mysql';
    const port = Number(process.env.WEBSHELL_DB_PORT || '3306');
    const user = process.env.WEBSHELL_DB_USER || 'webshell';
    const password = process.env.WEBSHELL_DB_PASSWORD || 'webshell_pass';
    const database = process.env.WEBSHELL_DB_DATABASE || 'webshell';

    const pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const db = new WebshellDb(pool);
    await db.initSchema();
    return db;
  }

  private async initSchema(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS targets (
        id varchar(191) primary key,
        host varchar(255) not null,
        port int not null,
        username varchar(255) not null,
        password text null,
        privateKey text null,
        name varchar(255) null
      )
    `;
    await this.pool.query(sql);

    const sessionSql = `
      CREATE TABLE IF NOT EXISTS sessions (
        id varchar(191) primary key,
        targetId varchar(191) not null,
        targetName varchar(255) null,
        host varchar(255) not null,
        port int not null,
        username varchar(255) not null,
        startTime datetime not null,
        endTime datetime null,
        status enum('connected', 'disconnected', 'error') not null,
        reason text null,
        index idx_targetId (targetId),
        index idx_startTime (startTime)
      )
    `;
    await this.pool.query(sessionSql);

    const userSql = `
      CREATE TABLE IF NOT EXISTS users (
        id varchar(191) primary key,
        username varchar(191) not null unique,
        password_hash varchar(255) not null,
        provider varchar(32) not null,
        created_at datetime not null,
        index idx_username (username)
      )
    `;
    await this.pool.query(userSql);

    const authSessionSql = `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token varchar(191) primary key,
        username varchar(191) not null,
        provider varchar(32) not null,
        created_at datetime not null,
        expires_at datetime not null,
        index idx_username (username),
        index idx_expires_at (expires_at)
      )
    `;
    await this.pool.query(authSessionSql);

    const dbName = process.env.WEBSHELL_DB_DATABASE || 'webshell';

    const [userProviderCols] = await this.pool.query(
      `
      SELECT COLUMN_NAME
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'users'
        AND column_name = 'provider'
    `,
      [dbName]
    );
    const userProviderList = userProviderCols as Array<{ COLUMN_NAME: string }>;
    if (userProviderList.length === 0) {
      await this.pool.query(
        `
        ALTER TABLE users
        ADD COLUMN provider varchar(32) not null default 'local'
      `
      );
    }

    const [authSessionProviderCols] = await this.pool.query(
      `
      SELECT COLUMN_NAME
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'auth_sessions'
        AND column_name = 'provider'
    `,
      [dbName]
    );
    const authSessionProviderList =
      authSessionProviderCols as Array<{ COLUMN_NAME: string }>;
    if (authSessionProviderList.length === 0) {
      await this.pool.query(
        `
        ALTER TABLE auth_sessions
        ADD COLUMN provider varchar(32) not null default 'local'
      `
      );
    }
  }

  async listTargets(): Promise<WebshellTargetRow[]> {
    const [rows] = await this.pool.query(
      'SELECT id, host, port, username, password, privateKey, name FROM targets ORDER BY id'
    );
    return rows as WebshellTargetRow[];
  }

  async getTarget(id: string): Promise<WebshellTargetRow | undefined> {
    const [rows] = await this.pool.query(
      'SELECT id, host, port, username, password, privateKey, name FROM targets WHERE id = ?',
      [id]
    );
    const list = rows as WebshellTargetRow[];
    return list[0];
  }

  async createTarget(target: WebshellTargetRow): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO targets (id, host, port, username, password, privateKey, name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        target.id,
        target.host,
        target.port,
        target.username,
        target.password,
        target.privateKey,
        target.name
      ]
    );
  }

  async updateTarget(target: WebshellTargetRow): Promise<void> {
    await this.pool.query(
      `
      UPDATE targets
      SET host = ?,
          port = ?,
          username = ?,
          password = ?,
          privateKey = ?,
          name = ?
      WHERE id = ?
    `,
      [
        target.host,
        target.port,
        target.username,
        target.password,
        target.privateKey,
        target.name,
        target.id
      ]
    );
  }

  async deleteTarget(id: string): Promise<void> {
    await this.pool.query('DELETE FROM targets WHERE id = ?', [id]);
  }

  async createSession(session: SessionHistoryRow): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO sessions (id, targetId, targetName, host, port, username, startTime, endTime, status, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        session.id,
        session.targetId,
        session.targetName,
        session.host,
        session.port,
        session.username,
        session.startTime,
        session.endTime,
        session.status,
        session.reason
      ]
    );
  }

  async updateSessionEndTime(
    id: string,
    endTime: Date,
    status: 'connected' | 'disconnected' | 'error'
  ): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET endTime = ?, status = ? WHERE id = ?',
      [endTime, status, id]
    );
  }

  async listSessions(
    limit: number = 100,
    offset: number = 0
  ): Promise<SessionHistoryRow[]> {
    const [rows] = await this.pool.query(
      `
      SELECT id, targetId, targetName, host, port, username, startTime, endTime, status, reason
      FROM sessions
      ORDER BY startTime DESC
      LIMIT ? OFFSET ?
    `,
      [limit, offset]
    );
    return rows as SessionHistoryRow[];
  }

  async getSessionCount(): Promise<number> {
    const [rows] = await this.pool.query('SELECT COUNT(*) as count FROM sessions');
    const result = rows as any[];
    return result[0].count;
  }

  async getUserByUsername(username: string): Promise<AuthUserRow | undefined> {
    const [rows] = await this.pool.query(
      `
      SELECT id, username, password_hash as passwordHash, provider, created_at as createdAt
      FROM users
      WHERE username = ?
    `,
      [username]
    );
    const list = rows as AuthUserRow[];
    return list[0];
  }

  async createUser(user: AuthUserRow): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO users (id, username, password_hash, provider, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      [user.id, user.username, user.passwordHash, user.provider, user.createdAt]
    );
  }

  async createAuthSession(session: AuthSessionRow): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO auth_sessions (token, username, provider, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      [
        session.token,
        session.username,
        session.provider,
        session.createdAt,
        session.expiresAt
      ]
    );
  }

  async getAuthSession(token: string): Promise<AuthSessionRow | undefined> {
    const [rows] = await this.pool.query(
      `
      SELECT token, username, provider, created_at as createdAt, expires_at as expiresAt
      FROM auth_sessions
      WHERE token = ?
    `,
      [token]
    );
    const list = rows as AuthSessionRow[];
    const session = list[0];
    if (!session) {
      return undefined;
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.deleteAuthSession(token);
      return undefined;
    }
    return session;
  }

  async deleteAuthSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE token = ?', [token]);
  }

  async pruneExpiredAuthSessions(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE expires_at <= ?', [now]);
  }
}

