import bcrypt from 'bcryptjs';
import * as jose from 'jose';
import crypto from 'node:crypto';
import type pg from 'pg';
import type { LoginInput, CreateUserInput, CreateAgentKeyInput } from './schemas.js';

interface TokenPayload {
  userId: string;
  practiceId: string;
  permissions: string[];
}

interface AgentKeyInfo {
  userId: string;
  practiceId: string;
  modelType: string;
  scopes: string[];
}

export class AuthService {
  private jwtSecret: Uint8Array;

  constructor(
    private pool: pg.Pool,
    jwtSecretString: string,
  ) {
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
  }

  async loadPermissions(userId: string): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT DISTINCT unnest(ur.permission_set) AS perm
      FROM user_role_assignments ura
      JOIN user_roles ur ON ur.id = ura.role_id
      WHERE ura.user_id = $1
      ORDER BY perm
    `, [userId]);
    return result.rows.map(r => r.perm);
  }

  async createUser(
    practiceId: string,
    input: CreateUserInput,
  ): Promise<{ id: string; email: string; fullName: string; permissions: string[] }> {
    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await this.pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, full_name`,
      [practiceId, input.email, passwordHash, input.fullName, input.isProvider, input.serviceLineIds],
    );

    const row = result.rows[0];

    for (const roleId of input.roleIds) {
      await this.pool.query(
        `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
        [row.id, roleId],
      );
    }

    const permissions = await this.loadPermissions(row.id);
    return { id: row.id, email: row.email, fullName: row.full_name, permissions };
  }

  async login(input: LoginInput): Promise<{ accessToken: string; refreshToken: string }> {
    const result = await this.pool.query(
      `SELECT id, practice_id, email, password_hash, is_active
       FROM users
       WHERE practice_id = $1 AND email = $2 AND is_active = true`,
      [input.practiceId, input.email],
    );

    const user = result.rows[0];
    if (!user) throw new Error('Invalid credentials');

    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) throw new Error('Invalid credentials');

    const permissions = await this.loadPermissions(user.id);

    const accessToken = await new jose.SignJWT({
      userId: user.id,
      practiceId: user.practice_id,
      permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.jwtSecret);

    const refreshToken = await new jose.SignJWT({
      userId: user.id,
      practiceId: user.practice_id,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return { accessToken, refreshToken };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { payload } = await jose.jwtVerify(refreshToken, this.jwtSecret);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');

    const userId = payload.userId as string;
    const practiceId = payload.practiceId as string;

    const result = await this.pool.query(
      'SELECT is_active FROM users WHERE id = $1 AND practice_id = $2',
      [userId, practiceId],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new Error('User not found or inactive');

    const permissions = await this.loadPermissions(userId);

    const accessToken = await new jose.SignJWT({
      userId,
      practiceId,
      permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.jwtSecret);

    const newRefreshToken = await new jose.SignJWT({
      userId,
      practiceId,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const { payload } = await jose.jwtVerify(token, this.jwtSecret);
    return {
      userId: payload.userId as string,
      practiceId: payload.practiceId as string,
      permissions: (payload.permissions as string[]) ?? [],
    };
  }

  async createAgentKey(
    practiceId: string,
    userId: string,
    input: CreateAgentKeyInput,
  ): Promise<{ rawKey: string; keyId: string }> {
    const rawKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, 12);

    const result = await this.pool.query(
      `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [practiceId, userId, keyHash, input.name, input.modelType, input.scopes],
    );

    return { rawKey, keyId: result.rows[0].id };
  }

  async verifyAgentKey(rawKey: string): Promise<AgentKeyInfo | null> {
    const keys = await this.pool.query(
      `SELECT ak.user_id, ak.practice_id, ak.key_hash, ak.model_type, ak.scopes
       FROM agent_keys ak
       WHERE ak.is_active = true`,
    );

    for (const key of keys.rows) {
      const valid = await bcrypt.compare(rawKey, key.key_hash);
      if (valid) {
        await this.pool.query(
          'UPDATE agent_keys SET last_used_at = NOW() WHERE user_id = $1 AND key_hash = $2',
          [key.user_id, key.key_hash],
        );
        return {
          userId: key.user_id,
          practiceId: key.practice_id,
          modelType: key.model_type,
          scopes: key.scopes,
        };
      }
    }

    return null;
  }
}
