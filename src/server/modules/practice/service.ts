import type pg from 'pg';
import type {
  UpdatePracticeInput,
  CreateServiceLineInput,
  UpdateServiceLineInput,
  UpdateUserInput,
  CreateRoleInput,
  UpdateRoleInput,
} from './schemas.js';

export interface PracticeRow {
  id: string;
  name: string;
  schedule_block_minutes: number;
  timezone: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ServiceLineRow {
  id: string;
  practice_id: string;
  name: string;
  color: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface UserAdminRow {
  id: string;
  practice_id: string;
  email: string;
  full_name: string;
  is_provider: boolean;
  service_line_ids: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  id: string;
  practice_id: string;
  name: string;
  permission_set: string[];
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleAssignmentRow {
  id: string;
  user_id: string;
  role_id: string;
  service_line_id: string | null;
  created_at: string;
}

export class PracticeService {
  constructor(private pool: pg.Pool) {}

  // --- PRACTICE SETTINGS ---

  async getPractice(practiceId: string): Promise<PracticeRow | null> {
    const result = await this.pool.query('SELECT * FROM practices WHERE id = $1', [practiceId]);
    return result.rows[0] ?? null;
  }

  async updatePractice(practiceId: string, input: UpdatePracticeInput): Promise<PracticeRow> {
    const fieldMap: Record<string, string> = {
      name: 'name',
      scheduleBlockMinutes: 'schedule_block_minutes',
      timezone: 'timezone',
      settings: 'settings',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(key === 'settings' ? JSON.stringify(value) : value);
    }

    if (setClauses.length === 1) {
      const existing = await this.getPractice(practiceId);
      if (!existing) throw new Error('Practice not found');
      return existing;
    }

    values.push(practiceId);

    const result = await this.pool.query(
      `UPDATE practices SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Practice not found');
    return result.rows[0];
  }

  // --- SERVICE LINES ---

  async listServiceLines(practiceId: string, includeInactive = false): Promise<ServiceLineRow[]> {
    const where = includeInactive
      ? 'practice_id = $1'
      : 'practice_id = $1 AND is_active = true';
    const result = await this.pool.query(
      `SELECT * FROM service_lines WHERE ${where} ORDER BY sort_order, name`,
      [practiceId],
    );
    return result.rows;
  }

  async createServiceLine(practiceId: string, input: CreateServiceLineInput): Promise<ServiceLineRow> {
    const result = await this.pool.query(
      `INSERT INTO service_lines (practice_id, name, color, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [practiceId, input.name, input.color, input.sortOrder],
    );
    return result.rows[0];
  }

  async updateServiceLine(
    practiceId: string,
    slId: string,
    input: UpdateServiceLineInput,
  ): Promise<ServiceLineRow> {
    const fieldMap: Record<string, string> = {
      name: 'name',
      color: 'color',
      sortOrder: 'sort_order',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 0) {
      const existing = await this.pool.query(
        'SELECT * FROM service_lines WHERE id = $1 AND practice_id = $2',
        [slId, practiceId],
      );
      if (existing.rows.length === 0) throw new Error('Service line not found');
      return existing.rows[0];
    }

    values.push(slId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE service_lines SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Service line not found');
    return result.rows[0];
  }

  async deactivateServiceLine(practiceId: string, slId: string): Promise<ServiceLineRow> {
    const result = await this.pool.query(
      `UPDATE service_lines SET is_active = false
       WHERE id = $1 AND practice_id = $2 RETURNING *`,
      [slId, practiceId],
    );
    if (result.rows.length === 0) throw new Error('Service line not found');
    return result.rows[0];
  }

  // --- USER ADMIN ---

  async listUsers(practiceId: string, includeInactive = false): Promise<UserAdminRow[]> {
    const where = includeInactive
      ? 'practice_id = $1'
      : 'practice_id = $1 AND is_active = true';
    const result = await this.pool.query(
      `SELECT id, practice_id, email, full_name, is_provider, service_line_ids,
              is_active, created_at, updated_at
       FROM users WHERE ${where} ORDER BY full_name`,
      [practiceId],
    );
    return result.rows;
  }

  async getUser(practiceId: string, userId: string): Promise<UserAdminRow | null> {
    const result = await this.pool.query(
      `SELECT id, practice_id, email, full_name, is_provider, service_line_ids,
              is_active, created_at, updated_at
       FROM users WHERE id = $1 AND practice_id = $2`,
      [userId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async updateUser(
    practiceId: string,
    userId: string,
    input: UpdateUserInput,
  ): Promise<UserAdminRow> {
    const fieldMap: Record<string, string> = {
      fullName: 'full_name',
      email: 'email',
      isActive: 'is_active',
      isProvider: 'is_provider',
      serviceLineIds: 'service_line_ids',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 1) {
      const existing = await this.getUser(practiceId, userId);
      if (!existing) throw new Error('User not found');
      return existing;
    }

    values.push(userId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING id, practice_id, email, full_name, is_provider, service_line_ids,
                 is_active, created_at, updated_at`,
      values,
    );
    if (result.rows.length === 0) throw new Error('User not found');
    return result.rows[0];
  }

  async listUserRoleAssignments(userId: string): Promise<(RoleAssignmentRow & { role_name: string; permission_set: string[] })[]> {
    const result = await this.pool.query(
      `SELECT ura.id, ura.user_id, ura.role_id, ura.service_line_id, ura.created_at,
              ur.name as role_name, ur.permission_set
       FROM user_role_assignments ura
       JOIN user_roles ur ON ur.id = ura.role_id
       WHERE ura.user_id = $1
       ORDER BY ur.name`,
      [userId],
    );
    return result.rows;
  }

  async assignRole(
    userId: string,
    roleId: string,
    serviceLineId: string | null,
  ): Promise<RoleAssignmentRow> {
    const result = await this.pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, service_line_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, roleId, serviceLineId],
    );
    return result.rows[0];
  }

  async removeRoleAssignment(userId: string, assignmentId: string): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM user_role_assignments WHERE id = $1 AND user_id = $2',
      [assignmentId, userId],
    );
    if (result.rowCount === 0) throw new Error('Role assignment not found');
  }

  // --- ROLES ---

  async listRoles(practiceId: string): Promise<RoleRow[]> {
    const result = await this.pool.query(
      'SELECT * FROM user_roles WHERE practice_id = $1 ORDER BY is_system DESC, name',
      [practiceId],
    );
    return result.rows;
  }

  async getRole(practiceId: string, roleId: string): Promise<RoleRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM user_roles WHERE id = $1 AND practice_id = $2',
      [roleId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async createRole(practiceId: string, input: CreateRoleInput): Promise<RoleRow> {
    const result = await this.pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, $2, $3, false) RETURNING *`,
      [practiceId, input.name, input.permissionSet],
    );
    return result.rows[0];
  }

  async updateRole(
    practiceId: string,
    roleId: string,
    input: UpdateRoleInput,
  ): Promise<RoleRow> {
    const existing = await this.getRole(practiceId, roleId);
    if (!existing) throw new Error('Role not found');
    if (existing.is_system) throw new Error('Cannot modify system role');

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.permissionSet !== undefined) {
      setClauses.push(`permission_set = $${idx++}`);
      values.push(input.permissionSet);
    }

    if (setClauses.length === 1) return existing;

    values.push(roleId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE user_roles SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    return result.rows[0];
  }

  async deleteRole(practiceId: string, roleId: string): Promise<void> {
    const existing = await this.getRole(practiceId, roleId);
    if (!existing) throw new Error('Role not found');
    if (existing.is_system) throw new Error('Cannot delete system role');

    await this.pool.query(
      'DELETE FROM user_roles WHERE id = $1 AND practice_id = $2',
      [roleId, practiceId],
    );
  }
}
