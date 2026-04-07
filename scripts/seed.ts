import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://osod:osod_dev@localhost:5432/osod';

async function seed() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  // Check if already seeded
  const existing = await pool.query('SELECT COUNT(*) FROM practices');
  if (parseInt(existing.rows[0].count) > 0) {
    console.log('Database already seeded. Drop and re-migrate to re-seed.');
    await pool.end();
    return;
  }

  console.log('Seeding OSOD development database...');

  // 1. Practice
  const practice = await pool.query(
    `INSERT INTO practices (name, schedule_block_minutes, timezone)
     VALUES ('IVA — Integrated Vision & Aesthetics', 15, 'America/Chicago')
     RETURNING id`
  );
  const practiceId = practice.rows[0].id;
  console.log(`  Practice: ${practiceId}`);

  // 2. Service lines
  const eyecare = await pool.query(
    `INSERT INTO service_lines (practice_id, name, color, sort_order)
     VALUES ($1, 'Eyecare', '#2563EB', 1) RETURNING id`,
    [practiceId]
  );
  const aesthetics = await pool.query(
    `INSERT INTO service_lines (practice_id, name, color, sort_order)
     VALUES ($1, 'Aesthetics', '#DB2777', 2) RETURNING id`,
    [practiceId]
  );
  const eyecareId = eyecare.rows[0].id;
  const aestheticsId = aesthetics.rows[0].id;
  console.log(`  Service lines: Eyecare (${eyecareId}), Aesthetics (${aestheticsId})`);

  // 3. Users
  const adminHash = await bcrypt.hash('admin123!', 12);
  const staffHash = await bcrypt.hash('staff123!', 12);

  const admin = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'eric@iva.com', $2, 'Dr. Eric Bang', 'admin', true, $3) RETURNING id`,
    [practiceId, adminHash, [eyecareId, aestheticsId]]
  );
  const drSmith = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'smith@iva.com', $2, 'Dr. Smith', 'provider', true, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId]]
  );
  const sarah = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'sarah@iva.com', $2, 'Sarah Johnson', 'provider', true, $3) RETURNING id`,
    [practiceId, staffHash, [aestheticsId]]
  );
  const frontDesk = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider)
     VALUES ($1, 'front@iva.com', $2, 'Front Desk', 'staff', false) RETURNING id`,
    [practiceId, staffHash]
  );
  console.log(`  Users: admin (${admin.rows[0].id}), providers + staff created`);

  const adminId = admin.rows[0].id;

  // 4. Agent keys
  const localAgentUser = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider)
     VALUES ($1, 'local-agent@agent.local', NULL, 'Local Scheduling Agent', 'agent', false) RETURNING id`,
    [practiceId]
  );
  const localKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
  const localKeyHash = await bcrypt.hash(localKey, 12);
  await pool.query(
    `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
     VALUES ($1, $2, $3, 'local-scheduler', 'local', $4)`,
    [practiceId, localAgentUser.rows[0].id, localKeyHash, ['patients:read', 'appointments:read', 'appointments:write']]
  );
  console.log(`  Local agent key: ${localKey}`);

  // 5. Appointment types
  const eyecareTypes = [
    ['Comprehensive Exam', 'COMP', '#2563EB', 2],
    ['Contact Lens Follow-Up', 'CLFU', '#059669', 1],
    ['Dry Eye Evaluation', 'DRY', '#D97706', 3],
    ['Vision Therapy', 'VT', '#7C3AED', 4],
    ['Emergency/Walk-In', 'EMER', '#DC2626', 1],
  ];
  for (const [name, shortName, color, blocks] of eyecareTypes) {
    await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [practiceId, eyecareId, name, shortName, color, blocks]
    );
  }

  const aestheticsTypes = [
    ['Botox', 'BTX', '#DB2777', 2],
    ['Filler', 'FIL', '#E11D48', 3],
    ['Chemical Peel', 'PEEL', '#F59E0B', 2],
    ['Skin Consultation', 'CONS', '#8B5CF6', 2],
    ['Laser Treatment', 'LASER', '#EF4444', 4],
  ];
  for (const [name, shortName, color, blocks] of aestheticsTypes) {
    await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [practiceId, aestheticsId, name, shortName, color, blocks]
    );
  }
  console.log('  Appointment types: 5 eyecare + 5 aesthetics');

  // 6. Provider schedules (Mon-Fri templates)
  for (let day = 1; day <= 5; day++) {
    // Dr. Bang: mornings eyecare, afternoons aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '12:00', $3)`,
      [admin.rows[0].id, day, eyecareId]
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '13:00', '17:00', $3)`,
      [admin.rows[0].id, day, aestheticsId]
    );
    // Dr. Smith: all day eyecare
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '17:00', $3)`,
      [drSmith.rows[0].id, day, eyecareId]
    );
    // Sarah: all day aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '09:00', '17:00', $3)`,
      [sarah.rows[0].id, day, aestheticsId]
    );
  }
  console.log('  Provider schedules: Mon-Fri for all 3 providers');

  // 7. Sample patients (20)
  const firstNames = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Sarah', 'David', 'Jennifer', 'William', 'Patricia',
                       'Richard', 'Elizabeth', 'Joseph', 'Barbara', 'Thomas', 'Susan', 'Charles', 'Jessica', 'Daniel', 'Karen'];
  const lastNames = ['Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson',
                      'Taylor', 'Thomas', 'Hernandez', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White', 'Lopez', 'Lee'];

  const patientIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        practiceId,
        firstNames[i],
        lastNames[i],
        `${1960 + i}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        i % 2 === 0 ? 'M' : 'F',
        `555-${String(1000 + i).padStart(4, '0')}`,
        `${100 + i} Main St`,
        'Edmond',
        'OK',
        '73034',
      ]
    );
    patientIds.push(result.rows[0].id);
  }
  console.log(`  Patients: 20 created`);

  // 8. Sample insurance (first 10 patients get vision insurance)
  for (let i = 0; i < 10; i++) {
    await pool.query(
      `INSERT INTO patient_insurance (patient_id, priority, plan_type, payer_name, member_id, effective_date)
       VALUES ($1, 1, 'vision', $2, $3, '2026-01-01')`,
      [patientIds[i], i % 2 === 0 ? 'VSP' : 'EyeMed', `MEM${String(10000 + i)}`]
    );
  }
  console.log('  Insurance: 10 patients with vision plans');

  // 9. Sample alerts
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'allergy', 'critical', 'Sulfa allergy — do NOT prescribe sulfonamide antibiotics', $2)`,
    [patientIds[0], adminId]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'balance', 'warning', 'Outstanding balance: $245.00 — collect before scheduling', $2)`,
    [patientIds[3], adminId]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'scheduling', 'info', 'Prefers morning appointments only', $2)`,
    [patientIds[7], adminId]
  );
  console.log('  Alerts: 3 sample alerts');

  console.log('\nSeed complete!');
  console.log('\nLogin credentials:');
  console.log('  Admin: eric@iva.com / admin123!');
  console.log('  Staff: front@iva.com / staff123!');
  console.log(`  Agent key: ${localKey}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
