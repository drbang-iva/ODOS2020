ALTER TABLE odos_package_ledger
  ADD COLUMN IF NOT EXISTS external_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS odos_package_ledger_expiry_once_idx
  ON odos_package_ledger (package_instance_id)
  WHERE entry_type = 'expiry';

CREATE TABLE IF NOT EXISTS odos_credit_bank_accounts (
  patient_fhir_id TEXT PRIMARY KEY CHECK (patient_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odos_credit_bank_ledger (
  id UUID PRIMARY KEY,
  patient_fhir_id TEXT NOT NULL REFERENCES odos_credit_bank_accounts(patient_fhir_id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL
    CHECK (entry_type IN ('deposit', 'bonus', 'spend', 'refund_in', 'adjustment', 'expiry')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  actor_user_id TEXT NOT NULL CHECK (btrim(actor_user_id) <> ''),
  reason TEXT,
  linked_fhir_invoice_id TEXT
    CHECK (linked_fhir_invoice_id IS NULL OR linked_fhir_invoice_id ~ '^[A-Za-z0-9.-]+$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (entry_type = 'deposit' AND amount_cents > 0 AND linked_fhir_invoice_id IS NOT NULL)
    OR (entry_type = 'bonus' AND amount_cents > 0 AND linked_fhir_invoice_id IS NULL
        AND reason IS NOT NULL AND btrim(reason) <> '')
    OR (entry_type = 'spend' AND amount_cents < 0 AND linked_fhir_invoice_id IS NOT NULL)
    OR (entry_type = 'refund_in' AND amount_cents > 0)
    OR (entry_type = 'adjustment' AND reason IS NOT NULL AND btrim(reason) <> '')
    OR (entry_type = 'expiry' AND amount_cents < 0)
  )
);

CREATE INDEX IF NOT EXISTS odos_credit_bank_ledger_patient_idx
  ON odos_credit_bank_ledger (patient_fhir_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS odos_credit_bank_ledger_deposit_invoice_once_idx
  ON odos_credit_bank_ledger (linked_fhir_invoice_id)
  WHERE entry_type = 'deposit';

CREATE UNIQUE INDEX IF NOT EXISTS odos_credit_bank_ledger_spend_invoice_once_idx
  ON odos_credit_bank_ledger (linked_fhir_invoice_id)
  WHERE entry_type = 'spend';

CREATE UNIQUE INDEX IF NOT EXISTS odos_credit_bank_ledger_refund_invoice_once_idx
  ON odos_credit_bank_ledger (linked_fhir_invoice_id)
  WHERE entry_type = 'refund_in';

CREATE TABLE IF NOT EXISTS odos_credit_bank_spends (
  charge_item_fhir_id TEXT PRIMARY KEY CHECK (charge_item_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  patient_fhir_id TEXT NOT NULL REFERENCES odos_credit_bank_accounts(patient_fhir_id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  invoice_fhir_id TEXT UNIQUE CHECK (invoice_fhir_id IS NULL OR invoice_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  payment_fhir_id TEXT UNIQUE CHECK (payment_fhir_id IS NULL OR payment_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  consumed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION odos_reject_credit_bank_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'odos_credit_bank_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS odos_credit_bank_ledger_append_only ON odos_credit_bank_ledger;
CREATE TRIGGER odos_credit_bank_ledger_append_only
  BEFORE UPDATE OR DELETE ON odos_credit_bank_ledger
  FOR EACH ROW EXECUTE FUNCTION odos_reject_credit_bank_ledger_mutation();
