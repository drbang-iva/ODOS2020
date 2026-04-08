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

  // ─── 1. Practice ───────────────────────────────────────────
  const practice = await pool.query(
    `INSERT INTO practices (name, schedule_block_minutes, timezone)
     VALUES ('IVA — Integrated Vision & Aesthetics', 15, 'America/Chicago')
     RETURNING id`
  );
  const practiceId = practice.rows[0].id;
  console.log(`  Practice: ${practiceId}`);

  // ─── 2. Service Lines ─────────────────────────────────────
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

  // ─── 3. Role Templates (Decision 4) ──────────────────────
  const roleDefinitions = [
    {
      name: 'Admin',
      permissions: [
        'admin:users', 'admin:settings',
        'patients:read', 'patients:write', 'patients:delete',
        'appointments:read', 'appointments:write',
        'billing:read', 'billing:submit', 'billing:void',
        'clinical:read', 'clinical:write',
        'images:read', 'images:write', 'images:delete',
        'inventory:read', 'inventory:adjust',
        'reports:read', 'reports:export',
      ],
    },
    {
      name: 'Provider',
      permissions: [
        'patients:read', 'patients:write',
        'appointments:read', 'appointments:write',
        'clinical:read', 'clinical:write',
        'images:read', 'images:write',
        'billing:read', 'reports:read',
      ],
    },
    {
      name: 'Front Desk',
      permissions: [
        'patients:read', 'patients:write',
        'appointments:read', 'appointments:write',
        'billing:read',
      ],
    },
    {
      name: 'Optician',
      permissions: [
        'patients:read', 'appointments:read',
        'inventory:read', 'inventory:adjust',
      ],
    },
    {
      name: 'Aesthetician',
      permissions: [
        'patients:read',
        'clinical:read', 'clinical:write',
        'images:read', 'images:write',
        'appointments:read',
      ],
    },
    {
      name: 'Tech',
      permissions: [
        'patients:read', 'appointments:read', 'clinical:read',
      ],
    },
    {
      name: 'Biller',
      permissions: [
        'patients:read',
        'billing:read', 'billing:submit', 'billing:void',
        'reports:read', 'reports:export',
      ],
    },
  ];

  const roles: Record<string, string> = {};
  for (const def of roleDefinitions) {
    const result = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [practiceId, def.name, def.permissions]
    );
    roles[def.name] = result.rows[0].id;
  }
  console.log(`  Roles: ${Object.keys(roles).join(', ')}`);

  // ─── 4. Users with Role Assignments ──────────────────────
  const adminHash = await bcrypt.hash('admin123!', 12);
  const staffHash = await bcrypt.hash('staff123!', 12);

  // Eric — Admin + Provider, both service lines
  const eric = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'eric@iva.com', $2, 'Dr. Eric Bang', true, $3) RETURNING id`,
    [practiceId, adminHash, [eyecareId, aestheticsId]]
  );
  const ericId = eric.rows[0].id;
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
    [ericId, roles['Admin']]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
    [ericId, roles['Provider']]
  );

  // Hannah — Front Desk (unscoped) + Optician (eyecare) + Aesthetician (aesthetics)
  const hannah = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'hannah@iva.com', $2, 'Hannah', false, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId, aestheticsId]]
  );
  const hannahId = hannah.rows[0].id;
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
    [hannahId, roles['Front Desk']]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`,
    [hannahId, roles['Optician'], eyecareId]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`,
    [hannahId, roles['Aesthetician'], aestheticsId]
  );

  // Dr. Smith — Provider, eyecare only
  const drSmith = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'smith@iva.com', $2, 'Dr. Smith', true, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId]]
  );
  const drSmithId = drSmith.rows[0].id;
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
    [drSmithId, roles['Provider']]
  );

  console.log(`  Users: Eric (${ericId}), Hannah (${hannahId}), Dr. Smith (${drSmithId})`);

  // ─── 5. Agent Key ────────────────────────────────────────
  const agentUser = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
     VALUES ($1, 'local-agent@agent.local', NULL, 'Local Scheduling Agent', false) RETURNING id`,
    [practiceId]
  );
  const localKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
  const localKeyHash = await bcrypt.hash(localKey, 12);
  await pool.query(
    `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
     VALUES ($1, $2, $3, 'local-scheduler', 'local', $4)`,
    [practiceId, agentUser.rows[0].id, localKeyHash, ['patients:read', 'appointments:read', 'appointments:write']]
  );
  console.log(`  Local agent key: ${localKey}`);

  // ─── 6. Treatment Library Presets (Decision 1) ────────────
  const treatmentPresets = [
    // Eyecare (12)
    { standard_name: 'Comprehensive Exam — New Patient', category: 'Routine Examinations', subcategory: null, duration: 45, cpt: ['99203','99204','92004'], equip: ['phoropter','slit_lamp','bio','autorefractor'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#2563EB' },
    { standard_name: 'Comprehensive Exam — Established', category: 'Routine Examinations', subcategory: null, duration: 30, cpt: ['99213','99214','92014'], equip: ['phoropter','slit_lamp','bio','autorefractor'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#2563EB' },
    { standard_name: 'Contact Lens Fit — Soft', category: 'Contact Lens Services', subcategory: 'Soft Lenses', duration: 30, cpt: ['92310'], equip: ['keratometer','slit_lamp'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#059669' },
    { standard_name: 'Contact Lens Fit — Scleral', category: 'Contact Lens Services', subcategory: 'Specialty Lenses', duration: 60, cpt: ['92313'], equip: ['topographer','slit_lamp','oct'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#059669' },
    { standard_name: 'Contact Lens Fit — Ortho-K', category: 'Contact Lens Services', subcategory: 'Specialty Lenses', duration: 60, cpt: ['92313'], equip: ['topographer','slit_lamp'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#059669' },
    { standard_name: 'Visual Field — Threshold 24-2', category: 'Diagnostic Testing', subcategory: null, duration: 20, cpt: ['92083'], equip: ['visual_field'], scope: ['Tech','Provider'], lines: ['eyecare'], body_area: false, color: '#6366F1' },
    { standard_name: 'OCT — Retinal/Macula', category: 'Diagnostic Testing', subcategory: null, duration: 15, cpt: ['92134'], equip: ['oct'], scope: ['Tech','Provider'], lines: ['eyecare'], body_area: false, color: '#6366F1' },
    { standard_name: 'OCT — Optic Nerve/RNFL', category: 'Diagnostic Testing', subcategory: null, duration: 15, cpt: ['92133'], equip: ['oct'], scope: ['Tech','Provider'], lines: ['eyecare'], body_area: false, color: '#6366F1' },
    { standard_name: 'Dry Eye Evaluation', category: 'Medical Eye Care', subcategory: 'Dry Eye', duration: 30, cpt: ['99213','99214'], equip: ['slit_lamp','meibographer'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#D97706' },
    { standard_name: 'Glaucoma Management', category: 'Medical Eye Care', subcategory: 'Glaucoma', duration: 30, cpt: ['99214','92083','92133'], equip: ['slit_lamp','visual_field','oct'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#DC2626' },
    { standard_name: 'Vision Therapy Session', category: 'Vision Therapy', subcategory: null, duration: 45, cpt: ['92065'], equip: [], scope: ['Provider','Tech'], lines: ['eyecare'], body_area: false, color: '#7C3AED' },
    { standard_name: 'Myopia Management Eval', category: 'Myopia Management', subcategory: null, duration: 45, cpt: ['92004'], equip: ['biometer','topographer'], scope: ['Provider'], lines: ['eyecare'], body_area: false, color: '#0891B2' },
    // Aesthetics (8)
    { standard_name: 'Neurotoxin Injection', category: 'Injectables', subcategory: 'Neurotoxin', duration: 30, cpt: ['64615','J0585'], equip: [], scope: ['Provider'], lines: ['aesthetics'], body_area: true, color: '#DB2777' },
    { standard_name: 'Dermal Filler', category: 'Injectables', subcategory: 'Filler', duration: 45, cpt: ['11950','11951'], equip: [], scope: ['Provider'], lines: ['aesthetics'], body_area: true, color: '#E11D48' },
    { standard_name: 'IPL Treatment', category: 'Light & Energy', subcategory: 'IPL', duration: 30, cpt: ['17999'], equip: ['ipl'], scope: ['Provider','Aesthetician'], lines: ['aesthetics','eyecare'], body_area: true, color: '#F59E0B' },
    { standard_name: 'RF Microneedling', category: 'Skin Rejuvenation', subcategory: null, duration: 60, cpt: ['17999'], equip: ['rf_microneedling'], scope: ['Provider','Aesthetician'], lines: ['aesthetics'], body_area: true, color: '#EF4444' },
    { standard_name: 'Chemical Peel', category: 'Skin Rejuvenation', subcategory: 'Peels', duration: 30, cpt: ['17999'], equip: [], scope: ['Provider','Aesthetician'], lines: ['aesthetics'], body_area: false, color: '#F59E0B' },
    { standard_name: 'HydraFacial', category: 'Skin Rejuvenation', subcategory: 'Facials', duration: 45, cpt: [], equip: ['hydrafacial'], scope: ['Aesthetician'], lines: ['aesthetics'], body_area: false, color: '#8B5CF6' },
    { standard_name: 'Laser Hair Removal', category: 'Light & Energy', subcategory: 'Laser', duration: 30, cpt: ['17999'], equip: ['laser_hair'], scope: ['Provider','Aesthetician'], lines: ['aesthetics'], body_area: true, color: '#EF4444' },
    { standard_name: 'Skin Consultation', category: 'Consultations', subcategory: null, duration: 30, cpt: ['99201'], equip: [], scope: ['Provider','Aesthetician'], lines: ['aesthetics'], body_area: false, color: '#8B5CF6' },
  ];

  // Map standard_name -> library id for later appointment type linking
  const libraryIds: Record<string, string> = {};

  for (const t of treatmentPresets) {
    const result = await pool.query(
      `INSERT INTO treatment_library
         (standard_name, category, subcategory, typical_duration_minutes,
          cpt_codes, equipment_tags, provider_scope, service_lines,
          body_area_modifiers_available, default_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        t.standard_name, t.category, t.subcategory, t.duration,
        t.cpt, t.equip, t.scope, t.lines,
        t.body_area, t.color,
      ]
    );
    libraryIds[t.standard_name] = result.rows[0].id;
  }
  console.log(`  Treatment library: ${treatmentPresets.length} presets`);

  // ─── 7. Body-Area Modifiers (Decision 1) ──────────────────
  const bodyAreas = [
    // General areas
    ['Face', 'FACE', 0],
    ['Neck', 'NECK', 0],
    ['Decollete', 'DECO', 0],
    ['Hands', 'HAND', -10],
    ['Arms', 'ARMS', 0],
    ['Underarms', 'UARM', -15],
    ['Abdomen', 'ABDO', 15],
    ['Back', 'BACK', 15],
    ['Flanks', 'FLNK', 0],
    ['Buttocks', 'BUTT', 15],
    ['Thighs', 'THGH', 15],
    ['Bikini', 'BIKI', 0],
    ['Full Legs', 'LEGS', 30],
    ['Scalp', 'SCLP', 0],
    // Face sub-areas
    ['Forehead', 'FRHD', -10],
    ['Glabella', 'GLAB', -15],
    ['Periorbital', 'PERI', -10],
    ['Cheeks', 'CHEK', 0],
    ['Lips', 'LIPS', -15],
    ['Chin', 'CHIN', -10],
    ['Jawline', 'JAWL', 0],
  ];

  for (const [name, code, adj] of bodyAreas) {
    await pool.query(
      `INSERT INTO body_area_modifiers (practice_id, name, short_code, duration_adjustment_minutes, is_system)
       VALUES (NULL, $1, $2, $3, true)`,
      [name, code, adj]
    );
  }
  console.log(`  Body-area modifiers: ${bodyAreas.length} system modifiers`);

  // ─── 8. Practice Appointment Types (cloned from library) ──
  // Map service_line name -> id
  const slMap: Record<string, string> = { eyecare: eyecareId, aesthetics: aestheticsId };

  // IVA display name overrides
  const displayOverrides: Record<string, string> = {
    'IPL Treatment': 'OptiLight IPL',
    'RF Microneedling': 'Morpheus8',
    'HydraFacial': 'Diamond HydroFacial',
    'Comprehensive Exam — New Patient': 'Comp Exam — New Patient',
    'Comprehensive Exam — Established': 'Comp Exam — Established',
  };

  for (const t of treatmentPresets) {
    const libId = libraryIds[t.standard_name];
    const displayName = displayOverrides[t.standard_name] ?? t.standard_name;
    const durationBlocks = Math.ceil(t.duration / 15); // 15-min blocks
    // Use first service line for the required service_line_id FK
    const primarySlId = slMap[t.lines[0]];
    const slIds = t.lines.map(l => slMap[l]);

    // Generate short_name from display name (first letters, max 4 chars)
    const shortName = displayName
      .replace(/[^A-Za-z\s]/g, '')
      .split(/\s+/)
      .map(w => w[0]?.toUpperCase() ?? '')
      .join('')
      .slice(0, 4);

    await pool.query(
      `INSERT INTO appointment_types
         (practice_id, service_line_id, name, short_name, color, duration_blocks,
          library_id, display_name, service_line_ids, equipment_tags,
          provider_scope, cpt_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        practiceId, primarySlId, t.standard_name, shortName, t.color, durationBlocks,
        libId, displayName, slIds, t.equip,
        t.scope, t.cpt,
      ]
    );
  }
  console.log(`  Appointment types: ${treatmentPresets.length} linked to treatment library`);

  // ─── 9. Provider Schedules (Mon-Fri) ─────────────────────
  for (let day = 1; day <= 5; day++) {
    // Eric: mornings eyecare, afternoons aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '12:00', $3)`,
      [ericId, day, eyecareId]
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '13:00', '17:00', $3)`,
      [ericId, day, aestheticsId]
    );
    // Dr. Smith: all day eyecare
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '17:00', $3)`,
      [drSmithId, day, eyecareId]
    );
  }
  console.log('  Provider schedules: Mon-Fri for Eric + Dr. Smith');

  // ─── 10. Patients with New Fields (Decision 2) ───────────
  const patientData = [
    ['James', 'R', 'Johnson', '1965-03-15', 'M', 'Manufacturing', 'Engineer', ['fishing','golf']],
    ['Maria', 'L', 'Williams', '1978-07-22', 'F', 'Greenwood Schools', 'Teacher', ['reading','gardening']],
    ['Robert', null, 'Brown', '1955-11-03', 'M', 'Retired', 'Retired', ['woodworking']],
    ['Linda', 'A', 'Jones', '1982-09-10', 'F', 'Self-Employed', 'Realtor', ['tennis','running']],
    ['Michael', 'J', 'Garcia', '1990-04-28', 'M', 'Tech Corp', 'Software Developer', ['gaming','cycling']],
    ['Sarah', 'K', 'Miller', '1973-12-01', 'F', 'Hospital', 'Nurse', ['yoga']],
    ['David', null, 'Davis', '1988-06-17', 'M', 'Construction Co', 'Foreman', ['hunting','fishing']],
    ['Jennifer', 'M', 'Rodriguez', '1995-02-14', 'F', 'University', 'Student', ['volleyball']],
    ['William', 'T', 'Martinez', '1960-08-30', 'M', 'Retired Military', 'Retired', ['golf','reading']],
    ['Patricia', null, 'Anderson', '1985-05-25', 'F', 'Law Firm', 'Paralegal', ['hiking']],
    ['Emma', 'R', 'Johnson', '2015-09-12', 'F', null, 'Student', []],
  ] as const;

  const patientIds: string[] = [];
  for (let i = 0; i < patientData.length; i++) {
    const [first, middle, last, dob, sex, employer, occupation, hobbies] = patientData[i];
    const result = await pool.query(
      `INSERT INTO patients
         (practice_id, first_name, middle_name, last_name, date_of_birth, sex,
          phone_primary, address_line1, city, state, zip,
          employer, occupation, hobbies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        practiceId, first, middle, last, dob, sex,
        `555-${String(1000 + i).padStart(4, '0')}`,
        `${100 + i} Main St`, 'Edmond', 'OK', '73034',
        employer, occupation, hobbies as unknown as string[],
      ]
    );
    patientIds.push(result.rows[0].id);
  }
  console.log(`  Patients: ${patientData.length} created (10 adults + 1 minor)`);

  // ─── 11. Responsible Party (Decision 3) ───────────────────
  // Emma (index 10) -> James (index 0) as parent
  await pool.query(
    `INSERT INTO responsible_parties
       (patient_id, responsible_party_patient_id, relationship,
        is_financial_responsible, is_consent_authority,
        is_insurance_subscriber, is_primary)
     VALUES ($1, $2, 'parent', true, true, true, true)`,
    [patientIds[10], patientIds[0]]
  );
  console.log('  Responsible party: Emma -> James (parent)');

  // ─── 12. Insurance (5 patients) ──────────────────────────
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO patient_insurance (patient_id, priority, plan_type, payer_name, member_id, effective_date)
       VALUES ($1, 1, 'vision', $2, $3, '2026-01-01')`,
      [patientIds[i], i % 2 === 0 ? 'VSP' : 'EyeMed', `MEM${String(10000 + i)}`]
    );
  }
  console.log('  Insurance: 5 patients with vision plans');

  // ─── 13. Alerts ──────────────────────────────────────────
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'allergy', 'critical', 'Sulfa allergy — do NOT prescribe sulfonamide antibiotics', $2)`,
    [patientIds[0], ericId]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'balance', 'warning', 'Outstanding balance: $245.00 — collect before scheduling', $2)`,
    [patientIds[3], ericId]
  );
  console.log('  Alerts: 2 (sulfa allergy on James, balance on Linda)');

  // ─── Done ────────────────────────────────────────────────
  console.log('\nSeed complete!');
  console.log('\nLogin credentials:');
  console.log('  Admin: eric@iva.com / admin123!');
  console.log('  Staff: hannah@iva.com / staff123!');
  console.log(`  Agent key: ${localKey}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
