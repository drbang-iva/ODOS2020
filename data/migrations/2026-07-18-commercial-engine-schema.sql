CREATE TABLE IF NOT EXISTS odos_package_definitions (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  eligible_procedure_type_codes TEXT[] NOT NULL CHECK (cardinality(eligible_procedure_type_codes) > 0),
  session_count INTEGER NOT NULL CHECK (session_count > 0),
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  expiry_days INTEGER NOT NULL DEFAULT 365 CHECK (expiry_days > 0),
  refund_policy TEXT NOT NULL DEFAULT 'non_refundable'
    CHECK (refund_policy IN ('non_refundable', 'store_credit_only', 'prorated_cash')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odos_package_instances (
  id UUID PRIMARY KEY,
  patient_fhir_id TEXT NOT NULL CHECK (patient_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  definition_id UUID NOT NULL REFERENCES odos_package_definitions(id) ON DELETE RESTRICT,
  snapshot_name TEXT NOT NULL CHECK (btrim(snapshot_name) <> ''),
  snapshot_eligible_procedure_type_codes TEXT[] NOT NULL
    CHECK (cardinality(snapshot_eligible_procedure_type_codes) > 0),
  snapshot_session_count INTEGER NOT NULL CHECK (snapshot_session_count > 0),
  snapshot_price_cents BIGINT NOT NULL CHECK (snapshot_price_cents > 0),
  snapshot_expiry_date DATE NOT NULL,
  snapshot_refund_policy TEXT NOT NULL
    CHECK (snapshot_refund_policy IN ('non_refundable', 'store_credit_only', 'prorated_cash')),
  source_sale_invoice_id TEXT NOT NULL UNIQUE CHECK (source_sale_invoice_id ~ '^[A-Za-z0-9.-]+$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, patient_fhir_id)
);

CREATE INDEX IF NOT EXISTS odos_package_instances_patient_idx
  ON odos_package_instances (patient_fhir_id, snapshot_expiry_date DESC);

CREATE TABLE IF NOT EXISTS odos_package_ledger (
  id UUID PRIMARY KEY,
  patient_fhir_id TEXT NOT NULL CHECK (patient_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  package_instance_id UUID NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'consumption', 'adjustment', 'expiry')),
  sessions_delta INTEGER NOT NULL CHECK (sessions_delta <> 0),
  actor_user_id TEXT NOT NULL CHECK (btrim(actor_user_id) <> ''),
  reason TEXT,
  linked_fhir_invoice_id TEXT CHECK (linked_fhir_invoice_id IS NULL OR linked_fhir_invoice_id ~ '^[A-Za-z0-9.-]+$'),
  linked_fhir_procedure_id TEXT CHECK (linked_fhir_procedure_id IS NULL OR linked_fhir_procedure_id ~ '^[A-Za-z0-9.-]+$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (package_instance_id, patient_fhir_id)
    REFERENCES odos_package_instances(id, patient_fhir_id) ON DELETE RESTRICT,
  CHECK (
    (entry_type = 'deposit' AND sessions_delta > 0 AND linked_fhir_invoice_id IS NOT NULL)
    OR (entry_type = 'consumption' AND sessions_delta = -1 AND linked_fhir_invoice_id IS NOT NULL AND linked_fhir_procedure_id IS NOT NULL)
    OR (entry_type = 'adjustment' AND reason IS NOT NULL AND btrim(reason) <> '')
    OR (entry_type = 'expiry' AND sessions_delta < 0)
  )
);

CREATE INDEX IF NOT EXISTS odos_package_ledger_instance_idx
  ON odos_package_ledger (package_instance_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS odos_package_ledger_consumption_once_idx
  ON odos_package_ledger (linked_fhir_procedure_id)
  WHERE entry_type = 'consumption';

CREATE TABLE IF NOT EXISTS odos_package_redemptions (
  procedure_fhir_id TEXT PRIMARY KEY CHECK (procedure_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  patient_fhir_id TEXT NOT NULL CHECK (patient_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  package_instance_id UUID NOT NULL,
  charge_item_fhir_id TEXT NOT NULL CHECK (charge_item_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  invoice_fhir_id TEXT UNIQUE CHECK (invoice_fhir_id IS NULL OR invoice_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  payment_fhir_id TEXT UNIQUE CHECK (payment_fhir_id IS NULL OR payment_fhir_id ~ '^[A-Za-z0-9.-]+$'),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (package_instance_id, patient_fhir_id)
    REFERENCES odos_package_instances(id, patient_fhir_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION odos_reject_package_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'odos_package_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS odos_package_ledger_append_only ON odos_package_ledger;
CREATE TRIGGER odos_package_ledger_append_only
  BEFORE UPDATE OR DELETE ON odos_package_ledger
  FOR EACH ROW EXECUTE FUNCTION odos_reject_package_ledger_mutation();
