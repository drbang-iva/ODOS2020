CREATE TABLE IF NOT EXISTS odos_claim_work_state (
    claim_reference TEXT PRIMARY KEY CHECK (claim_reference ~ '^Claim/[A-Za-z0-9.-]{1,64}$'),
    claim_number TEXT NOT NULL CHECK (claim_number <> ''),
    patient_reference TEXT NOT NULL CHECK (patient_reference ~ '^Patient/[A-Za-z0-9.-]{1,64}$'),
    patient_display TEXT NOT NULL,
    provider_reference TEXT NOT NULL,
    provider_display TEXT NOT NULL,
    cpt_codes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cpt_codes) = 'array'),
    total_charged_cents INTEGER NOT NULL CHECK (total_charged_cents >= 0),
    collected_cents INTEGER NOT NULL CHECK (collected_cents >= 0),
    patient_responsibility_cents INTEGER NOT NULL CHECK (patient_responsibility_cents >= 0),
    claim_status TEXT NOT NULL CHECK (claim_status <> ''),
    payer_reference TEXT NOT NULL,
    payer_display TEXT NOT NULL,
    office_reference TEXT,
    office_display TEXT,
    billed_at TIMESTAMPTZ NOT NULL,
    is_open BOOLEAN NOT NULL,
    touch_count INTEGER NOT NULL DEFAULT 0 CHECK (touch_count >= 0),
    last_touched_at TIMESTAMPTZ,
    last_touched_by TEXT,
    reason_code TEXT,
    reason_display TEXT,
    resolution_path TEXT,
    projected_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT claim_touch_facts_are_honest CHECK (
        (touch_count = 0 AND last_touched_at IS NULL AND last_touched_by IS NULL)
        OR (touch_count > 0 AND last_touched_at IS NOT NULL AND last_touched_by IS NOT NULL)
    ),
    CONSTRAINT claim_reason_is_typed CHECK (
        (reason_code IS NULL AND reason_display IS NULL AND resolution_path IS NULL)
        OR (reason_code IS NOT NULL AND reason_display IS NOT NULL AND resolution_path IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_claim_work_state_follow_up
    ON odos_claim_work_state (is_open, touch_count, billed_at, reason_code)
    WHERE is_open;
CREATE INDEX IF NOT EXISTS idx_claim_work_state_reason
    ON odos_claim_work_state (reason_code, is_open)
    WHERE is_open;
CREATE INDEX IF NOT EXISTS idx_claim_work_state_payer_month
    ON odos_claim_work_state (payer_reference, billed_at, collected_cents, touch_count);
CREATE INDEX IF NOT EXISTS idx_claim_work_state_last_touch
    ON odos_claim_work_state (last_touched_at DESC NULLS LAST);
