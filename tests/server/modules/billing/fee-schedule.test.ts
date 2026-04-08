import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('FeeScheduleService', () => {
  let pool: pg.Pool;
  let service: FeeScheduleService;
  let practiceId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    service = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Fee Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('schedules', () => {
    it('creates a fee schedule', async () => {
      const sch = await service.create(practiceId, {
        name: 'Cash Pay',
        description: 'Self-pay rates',
        isDefault: true,
      });
      expect(sch.id).toBeDefined();
      expect(sch.name).toBe('Cash Pay');
      expect(sch.is_default).toBe(true);
      expect(sch.is_active).toBe(true);
    });

    it('marking a new schedule as default unsets the previous default', async () => {
      const first = await service.create(practiceId, { name: 'First', isDefault: true });
      const second = await service.create(practiceId, { name: 'Second', isDefault: true });

      const reload = await service.get(practiceId, first.id);
      expect(reload?.is_default).toBe(false);
      expect(second.is_default).toBe(true);
    });

    it('lists active schedules with default first', async () => {
      await service.create(practiceId, { name: 'Cash', isDefault: true });
      await service.create(practiceId, { name: 'Medicare', isDefault: false });

      const list = await service.list(practiceId);
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('Cash');
    });

    it('getDefault returns the practice default schedule', async () => {
      await service.create(practiceId, { name: 'Cash', isDefault: true });
      const def = await service.getDefault(practiceId);
      expect(def?.name).toBe('Cash');
    });

    it('updates schedule fields', async () => {
      const sch = await service.create(practiceId, { name: 'V1' });
      const updated = await service.update(practiceId, sch.id, { name: 'V2', description: 'New desc' });
      expect(updated.name).toBe('V2');
      expect(updated.description).toBe('New desc');
    });

    it('deactivates schedule (soft delete)', async () => {
      const sch = await service.create(practiceId, { name: 'Old Schedule' });
      const deactivated = await service.deactivate(practiceId, sch.id);
      expect(deactivated.is_active).toBe(false);
    });

    it('does not return schedules from another practice', async () => {
      const sch = await service.create(practiceId, { name: 'Mine' });
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      const fetched = await service.get(otherPractice.rows[0].id, sch.id);
      expect(fetched).toBeNull();
    });
  });

  describe('items', () => {
    let scheduleId: string;

    beforeEach(async () => {
      const sch = await service.create(practiceId, { name: 'Standard', isDefault: true });
      scheduleId = sch.id;
    });

    it('adds an item to a schedule', async () => {
      const item = await service.addItem(practiceId, scheduleId, {
        cptCode: '92004',
        description: 'Comprehensive ophthalmological exam, new patient',
        amountCents: 22500,
      });
      expect(item.cpt_code).toBe('92004');
      expect(item.amount_cents).toBe(22500);
    });

    it('lists items in a schedule', async () => {
      await service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
      await service.addItem(practiceId, scheduleId, { cptCode: '92014', amountCents: 18500 });
      const items = await service.listItems(scheduleId);
      expect(items).toHaveLength(2);
    });

    it('rejects duplicate CPT+modifier in the same schedule', async () => {
      await service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
      await expect(
        service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 25000 }),
      ).rejects.toThrow();
    });

    it('allows same CPT with different modifiers', async () => {
      await service.addItem(practiceId, scheduleId, {
        cptCode: '92083',
        modifier: '26',
        amountCents: 8500,
      });
      const second = await service.addItem(practiceId, scheduleId, {
        cptCode: '92083',
        modifier: 'TC',
        amountCents: 3500,
      });
      expect(second.modifier).toBe('TC');
    });

    it('updates item amount', async () => {
      const item = await service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
      const updated = await service.updateItem(practiceId, scheduleId, item.id, { amountCents: 25000 });
      expect(updated.amount_cents).toBe(25000);
    });

    it('deletes an item', async () => {
      const item = await service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
      await service.deleteItem(practiceId, scheduleId, item.id);
      const list = await service.listItems(scheduleId);
      expect(list).toHaveLength(0);
    });

    it('rejects adding items to another practice schedule', async () => {
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      await expect(
        service.addItem(otherPractice.rows[0].id, scheduleId, {
          cptCode: '92004',
          amountCents: 22500,
        }),
      ).rejects.toThrow('not found');
    });

    it('lookupPrice returns the price for a CPT', async () => {
      await service.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
      const price = await service.lookupPrice(scheduleId, '92004');
      expect(price).toBe(22500);
    });

    it('lookupPrice returns null for unknown CPT', async () => {
      const price = await service.lookupPrice(scheduleId, '99999');
      expect(price).toBeNull();
    });

    it('lookupPrice respects modifier', async () => {
      await service.addItem(practiceId, scheduleId, {
        cptCode: '92083',
        modifier: '26',
        amountCents: 8500,
      });
      await service.addItem(practiceId, scheduleId, {
        cptCode: '92083',
        modifier: 'TC',
        amountCents: 3500,
      });

      expect(await service.lookupPrice(scheduleId, '92083', '26')).toBe(8500);
      expect(await service.lookupPrice(scheduleId, '92083', 'TC')).toBe(3500);
    });
  });

  describe('bulkAddItems', () => {
    let scheduleId: string;

    beforeEach(async () => {
      const sch = await service.create(practiceId, { name: 'Bulk Test', isDefault: true });
      scheduleId = sch.id;
    });

    it('inserts all items in a single batch', async () => {
      const result = await service.bulkAddItems(practiceId, scheduleId, {
        items: [
          { cptCode: '92004', amountCents: 22500 },
          { cptCode: '92014', amountCents: 18500 },
          { cptCode: '92083', amountCents: 8500 },
        ],
        skipExisting: false,
      });

      expect(result.inserted).toBe(3);
      expect(result.skipped).toBe(0);

      const list = await service.listItems(scheduleId);
      expect(list).toHaveLength(3);
    });

    it('rolls back the entire batch on duplicate when skipExisting=false', async () => {
      // Seed one item first
      await service.addItem(practiceId, scheduleId, {
        cptCode: '92004',
        amountCents: 22500,
      });

      // Batch that contains a duplicate of 92004 should fail entirely
      await expect(
        service.bulkAddItems(practiceId, scheduleId, {
          items: [
            { cptCode: '92014', amountCents: 18500 }, // new — would succeed
            { cptCode: '92004', amountCents: 25000 }, // duplicate — causes failure
            { cptCode: '92083', amountCents: 8500 }, // new — would succeed
          ],
          skipExisting: false,
        }),
      ).rejects.toThrow();

      // Verify NONE of the new items were committed (transaction rollback)
      const list = await service.listItems(scheduleId);
      expect(list).toHaveLength(1); // Only the originally-seeded 92004
      expect(list[0].cpt_code).toBe('92004');
    });

    it('silently skips duplicates when skipExisting=true', async () => {
      await service.addItem(practiceId, scheduleId, {
        cptCode: '92004',
        amountCents: 22500,
      });

      const result = await service.bulkAddItems(practiceId, scheduleId, {
        items: [
          { cptCode: '92014', amountCents: 18500 }, // new
          { cptCode: '92004', amountCents: 25000 }, // duplicate — skipped
          { cptCode: '92083', amountCents: 8500 }, // new
        ],
        skipExisting: true,
      });

      expect(result.inserted).toBe(2);
      expect(result.skipped).toBe(1);

      const list = await service.listItems(scheduleId);
      expect(list).toHaveLength(3); // original 92004 + two new
      // Original price stays — skipExisting doesn't overwrite
      const original = list.find((i) => i.cpt_code === '92004');
      expect(original?.amount_cents).toBe(22500);
    });

    it('rejects bulk add for nonexistent schedule', async () => {
      await expect(
        service.bulkAddItems(practiceId, '00000000-0000-0000-0000-000000000000', {
          items: [{ cptCode: '92004', amountCents: 22500 }],
          skipExisting: false,
        }),
      ).rejects.toThrow('not found');
    });

    it('rejects bulk add for another practice schedule', async () => {
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      await expect(
        service.bulkAddItems(otherPractice.rows[0].id, scheduleId, {
          items: [{ cptCode: '92004', amountCents: 22500 }],
          skipExisting: false,
        }),
      ).rejects.toThrow('not found');
    });

    it('handles CPT with and without modifier in the same batch', async () => {
      const result = await service.bulkAddItems(practiceId, scheduleId, {
        items: [
          { cptCode: '92083', amountCents: 12000 }, // no modifier
          { cptCode: '92083', modifier: '26', amountCents: 8500 }, // with modifier
          { cptCode: '92083', modifier: 'TC', amountCents: 3500 },
        ],
        skipExisting: false,
      });

      expect(result.inserted).toBe(3);
      const list = await service.listItems(scheduleId);
      expect(list).toHaveLength(3);
    });
  });
});
