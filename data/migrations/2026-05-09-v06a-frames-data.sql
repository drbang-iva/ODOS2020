-- OSOD v0.6a Frames Data integration substrate.
-- Closure-aligned: operator-uploaded bulk file ingest only; no outbound Frames Data API path.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS osod_catalog_sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_type TEXT NOT NULL CHECK (catalog_type IN ('frames', 'hcpcs', 'cpt', 'lenses', 'contacts', 'services')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IN ('success', 'failure', 'partial') OR outcome IS NULL),
    source_url TEXT NOT NULL,
    access_date DATE NOT NULL,
    source_version TEXT,
    rows_inserted INTEGER CHECK (rows_inserted IS NULL OR rows_inserted >= 0),
    rows_retired INTEGER CHECK (rows_retired IS NULL OR rows_retired >= 0),
    audit_event_id TEXT,
    error_summary TEXT,
    cursor_high_water TIMESTAMPTZ,
    sync_mode TEXT NOT NULL DEFAULT 'bulk' CHECK (sync_mode IN ('bulk', 'delta', 'reconciliation')),
    sync_run_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sync_run_complete_requires_version CHECK (
        completed_at IS NULL OR source_version IS NOT NULL
    ),
    CONSTRAINT frames_v06a_bulk_only CHECK (
        catalog_type <> 'frames' OR sync_mode = 'bulk'
    ),
    CONSTRAINT frames_v06a_cursor_null CHECK (
        catalog_type <> 'frames' OR cursor_high_water IS NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_catalog_sync_runs_active
    ON osod_catalog_sync_runs (catalog_type, started_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_sync_runs_history
    ON osod_catalog_sync_runs (catalog_type, completed_at DESC) WHERE completed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION osod_catalog_sync_runs_block_update_after_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'osod_catalog_sync_runs: row is closed; UPDATE forbidden'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS osod_catalog_sync_runs_block_update_trigger ON osod_catalog_sync_runs;
CREATE TRIGGER osod_catalog_sync_runs_block_update_trigger
    BEFORE UPDATE ON osod_catalog_sync_runs
    FOR EACH ROW EXECUTE FUNCTION osod_catalog_sync_runs_block_update_after_close();

CREATE TABLE IF NOT EXISTS osod_catalog_overlays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id TEXT NOT NULL CHECK (practice_id <> ''),
    catalog_type TEXT NOT NULL CHECK (catalog_type IN ('frames', 'lenses', 'contacts', 'services')),
    catalog_canonical_url TEXT NOT NULL CHECK (catalog_canonical_url ~ '^https://osod\.dev/catalog/[a-z-]+/.+'),
    overlay_kind TEXT NOT NULL CHECK (overlay_kind IN (
        'price_override',
        'lab_cost_override',
        'description_override',
        'recommended_flag',
        'blacklist_flag',
        'preferred_lab_link',
        'publicity_flag'
    )),
    overlay_value JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    audit_event_id TEXT NOT NULL,
    CONSTRAINT osod_catalog_overlays_unique_per_practice_per_kind
        UNIQUE (practice_id, catalog_type, catalog_canonical_url, overlay_kind)
);

CREATE INDEX IF NOT EXISTS idx_catalog_overlays_practice
    ON osod_catalog_overlays (practice_id, catalog_type);
CREATE INDEX IF NOT EXISTS idx_catalog_overlays_canonical
    ON osod_catalog_overlays (catalog_canonical_url);

ALTER TABLE osod_catalog_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE osod_catalog_overlays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osod_catalog_overlays_practice_isolation ON osod_catalog_overlays;
CREATE POLICY osod_catalog_overlays_practice_isolation
    ON osod_catalog_overlays
    USING (practice_id = current_setting('osod.practice_id', true))
    WITH CHECK (practice_id = current_setting('osod.practice_id', true));

CREATE TABLE IF NOT EXISTS osod_frames_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku_id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    manufacturer_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    color_code TEXT NOT NULL,
    color_name TEXT NOT NULL,
    source_color_raw TEXT NOT NULL,
    source_material_raw TEXT NOT NULL,
    frame_shape TEXT CHECK (frame_shape IN (
        'aviator', 'cat-eye', 'rectangular', 'oval', 'round',
        'square', 'wayfarer', 'geometric', 'oversized', 'wraparound', 'other'
    ) OR frame_shape IS NULL),
    gender_category TEXT CHECK (gender_category IN ('men', 'women', 'unisex', 'kids') OR gender_category IS NULL),
    age_group TEXT CHECK (age_group IN ('adult', 'youth', 'pediatric', 'infant') OR age_group IS NULL),
    color_group TEXT,
    finish TEXT CHECK (finish IN ('matte', 'gloss', 'satin', 'mixed', 'other') OR finish IS NULL),
    progressive_compatible BOOLEAN,
    min_fitting_height_mm INTEGER CHECK (min_fitting_height_mm IS NULL OR min_fitting_height_mm >= 0),
    eyesize_mm INTEGER CHECK (eyesize_mm IS NULL OR eyesize_mm >= 0),
    dbl_mm INTEGER CHECK (dbl_mm IS NULL OR dbl_mm >= 0),
    temple_mm INTEGER CHECK (temple_mm IS NULL OR temple_mm >= 0),
    b_mm INTEGER CHECK (b_mm IS NULL OR b_mm >= 0),
    ed_mm INTEGER CHECK (ed_mm IS NULL OR ed_mm >= 0),
    weight_grams NUMERIC(6,2) CHECK (weight_grams IS NULL OR weight_grams >= 0),
    material_code TEXT,
    country_of_origin TEXT CHECK (country_of_origin IS NULL OR country_of_origin ~ '^[A-Z]{2}$'),
    msrp_cents INTEGER CHECK (msrp_cents IS NULL OR msrp_cents >= 0),
    lab_cost_cents INTEGER CHECK (lab_cost_cents IS NULL OR lab_cost_cents >= 0),
    gtin14 CHARACTER(14) CHECK (gtin14 IS NULL OR gtin14 ~ '^[0-9]{14}$'),
    item_number TEXT,
    publicity_class TEXT NOT NULL DEFAULT 'staff_only'
        CHECK (publicity_class IN ('staff_only', 'no_public_price', 'open')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'discontinued')),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to TIMESTAMPTZ,
    source_version TEXT NOT NULL,
    source_url TEXT NOT NULL,
    access_date DATE NOT NULL,
    sync_run_id UUID NOT NULL REFERENCES osod_catalog_sync_runs(id),
    audit_event_id TEXT NOT NULL,
    CONSTRAINT osod_frames_catalog_sku_effective_unique UNIQUE (sku_id, effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_frames_catalog_sku_active_unique
    ON osod_frames_catalog (sku_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_frames_catalog_brand_active
    ON osod_frames_catalog (brand_name) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_frames_catalog_gtin14_active
    ON osod_frames_catalog (gtin14) WHERE effective_to IS NULL AND gtin14 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_frames_catalog_search
    ON osod_frames_catalog USING gin (
        to_tsvector('english', brand_name || ' ' || model_name || ' ' || color_name)
    ) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_frames_catalog_demographic
    ON osod_frames_catalog (gender_category, age_group)
    WHERE effective_to IS NULL AND status = 'active';

CREATE OR REPLACE FUNCTION osod_frames_catalog_block_payload_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.effective_to IS DISTINCT FROM NEW.effective_to
       AND current_setting('osod.frames_catalog_retire', true) <> 'on' THEN
        RAISE EXCEPTION 'osod_frames_catalog: effective_to can only change through osod_frames_catalog_retire()'
            USING ERRCODE = '42501';
    END IF;

    IF (OLD.sku_id IS DISTINCT FROM NEW.sku_id)
       OR (OLD.brand_id IS DISTINCT FROM NEW.brand_id)
       OR (OLD.brand_name IS DISTINCT FROM NEW.brand_name)
       OR (OLD.manufacturer_id IS DISTINCT FROM NEW.manufacturer_id)
       OR (OLD.manufacturer_name IS DISTINCT FROM NEW.manufacturer_name)
       OR (OLD.model_name IS DISTINCT FROM NEW.model_name)
       OR (OLD.color_code IS DISTINCT FROM NEW.color_code)
       OR (OLD.color_name IS DISTINCT FROM NEW.color_name)
       OR (OLD.source_color_raw IS DISTINCT FROM NEW.source_color_raw)
       OR (OLD.source_material_raw IS DISTINCT FROM NEW.source_material_raw)
       OR (OLD.frame_shape IS DISTINCT FROM NEW.frame_shape)
       OR (OLD.gender_category IS DISTINCT FROM NEW.gender_category)
       OR (OLD.age_group IS DISTINCT FROM NEW.age_group)
       OR (OLD.color_group IS DISTINCT FROM NEW.color_group)
       OR (OLD.finish IS DISTINCT FROM NEW.finish)
       OR (OLD.progressive_compatible IS DISTINCT FROM NEW.progressive_compatible)
       OR (OLD.min_fitting_height_mm IS DISTINCT FROM NEW.min_fitting_height_mm)
       OR (OLD.eyesize_mm IS DISTINCT FROM NEW.eyesize_mm)
       OR (OLD.dbl_mm IS DISTINCT FROM NEW.dbl_mm)
       OR (OLD.temple_mm IS DISTINCT FROM NEW.temple_mm)
       OR (OLD.b_mm IS DISTINCT FROM NEW.b_mm)
       OR (OLD.ed_mm IS DISTINCT FROM NEW.ed_mm)
       OR (OLD.weight_grams IS DISTINCT FROM NEW.weight_grams)
       OR (OLD.material_code IS DISTINCT FROM NEW.material_code)
       OR (OLD.country_of_origin IS DISTINCT FROM NEW.country_of_origin)
       OR (OLD.msrp_cents IS DISTINCT FROM NEW.msrp_cents)
       OR (OLD.lab_cost_cents IS DISTINCT FROM NEW.lab_cost_cents)
       OR (OLD.gtin14 IS DISTINCT FROM NEW.gtin14)
       OR (OLD.item_number IS DISTINCT FROM NEW.item_number)
       OR (OLD.publicity_class IS DISTINCT FROM NEW.publicity_class)
       OR (OLD.status IS DISTINCT FROM NEW.status)
       OR (OLD.effective_from IS DISTINCT FROM NEW.effective_from)
       OR (OLD.source_version IS DISTINCT FROM NEW.source_version)
       OR (OLD.source_url IS DISTINCT FROM NEW.source_url)
       OR (OLD.access_date IS DISTINCT FROM NEW.access_date)
       OR (OLD.sync_run_id IS DISTINCT FROM NEW.sync_run_id)
       OR (OLD.audit_event_id IS DISTINCT FROM NEW.audit_event_id) THEN
        RAISE EXCEPTION 'osod_frames_catalog: payload columns are append-only; retire + insert a new version'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS osod_frames_catalog_block_payload_update_trigger ON osod_frames_catalog;
CREATE TRIGGER osod_frames_catalog_block_payload_update_trigger
    BEFORE UPDATE ON osod_frames_catalog
    FOR EACH ROW EXECUTE FUNCTION osod_frames_catalog_block_payload_update();

CREATE OR REPLACE FUNCTION osod_frames_catalog_retire(
    row_id UUID,
    retired_at_ts TIMESTAMPTZ,
    by_sync_run_id UUID,
    by_audit_event_id TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('osod.frames_catalog_retire', 'on', true);
    UPDATE osod_frames_catalog
    SET effective_to = retired_at_ts
    WHERE id = row_id
      AND effective_to IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'osod_frames_catalog_retire: row % not found or already retired (sync run %, audit event %)', row_id, by_sync_run_id, by_audit_event_id;
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS osod_practice_frames_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id TEXT NOT NULL CHECK (practice_id <> ''),
    catalog_canonical_url TEXT NOT NULL CHECK (catalog_canonical_url ~ '^https://osod\.dev/catalog/frames/.+'),
    qty_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
    dispensary_location TEXT,
    inventory_status TEXT NOT NULL DEFAULT 'active'
        CHECK (inventory_status IN ('active', 'clearance', 'hold', 'discontinued_local')),
    practice_sale_price_cents INTEGER CHECK (practice_sale_price_cents IS NULL OR practice_sale_price_cents >= 0),
    practice_lab_cost_cents INTEGER CHECK (practice_lab_cost_cents IS NULL OR practice_lab_cost_cents >= 0),
    last_counted_at TIMESTAMPTZ,
    last_sold_at TIMESTAMPTZ,
    reorder_threshold INTEGER CHECK (reorder_threshold IS NULL OR reorder_threshold >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    audit_event_id TEXT NOT NULL,
    CONSTRAINT osod_practice_frames_inventory_unique_per_practice
        UNIQUE (practice_id, catalog_canonical_url)
);

CREATE INDEX IF NOT EXISTS idx_practice_frames_inventory_practice
    ON osod_practice_frames_inventory (practice_id) WHERE inventory_status = 'active';
CREATE INDEX IF NOT EXISTS idx_practice_frames_inventory_low_stock
    ON osod_practice_frames_inventory (practice_id, qty_on_hand)
    WHERE inventory_status = 'active' AND reorder_threshold IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_practice_frames_inventory_canonical
    ON osod_practice_frames_inventory (catalog_canonical_url)
    WHERE inventory_status = 'active';

ALTER TABLE osod_practice_frames_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE osod_practice_frames_inventory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osod_practice_frames_inventory_tenant_isolation ON osod_practice_frames_inventory;
CREATE POLICY osod_practice_frames_inventory_tenant_isolation
    ON osod_practice_frames_inventory
    USING (practice_id = current_setting('osod.practice_id', true))
    WITH CHECK (practice_id = current_setting('osod.practice_id', true));

CREATE OR REPLACE VIEW osod_practice_frames_inventory_active AS
SELECT
    inv.*,
    cat.id AS active_catalog_row_id,
    cat.brand_name,
    cat.model_name,
    cat.color_name,
    cat.eyesize_mm,
    cat.dbl_mm,
    cat.temple_mm,
    cat.b_mm,
    cat.ed_mm,
    cat.gtin14,
    cat.msrp_cents,
    cat.publicity_class
FROM osod_practice_frames_inventory inv
JOIN osod_frames_catalog cat
    ON cat.effective_to IS NULL
   AND ('https://osod.dev/catalog/frames/' || cat.sku_id) = inv.catalog_canonical_url;

CREATE TABLE IF NOT EXISTS osod_terminology_hcpcs (
    code TEXT PRIMARY KEY,
    display TEXT NOT NULL,
    description TEXT,
    parent_code TEXT,
    category TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    effective_from DATE NOT NULL,
    effective_to DATE,
    metadata JSONB,
    version TEXT NOT NULL,
    source_version TEXT NOT NULL,
    last_synced TIMESTAMPTZ NOT NULL DEFAULT now(),
    audit_event_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminology_hcpcs_active
    ON osod_terminology_hcpcs (code) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_terminology_hcpcs_category
    ON osod_terminology_hcpcs (category) WHERE active = true;

ALTER TABLE osod_audit_events
    DROP CONSTRAINT IF EXISTS osod_audit_events_event_type_check;

ALTER TABLE osod_audit_events
    ADD CONSTRAINT osod_audit_events_event_type_check CHECK (
        event_type IN (
            'read', 'search', 'history', 'vread',
            'create', 'update', 'patch', 'transaction', 'nullify-attempt', 'delete-attempt',
            'denied',
            'break-glass-invoked', 'break-glass-expired',
            'login', 'logout', 'login-failed',
            'role-change', 'policy-change', 'projectmembership-lifecycle',
            'backup-started', 'backup-completed', 'restore-started', 'restore-completed',
            'external-api-call',
            'preflight-block', 'noop',
            'smart-token-issue', 'smart-token-refresh', 'smart-token-revoke',
            'smart-introspection', 'smart-discovery-fetch',
            'smart-scope-staged-review', 'smart-scope-approved', 'smart-scope-rejected',
            'smart-sandbox-register',
            'smart-app-registered', 'smart-app-jurisdiction-blocked',
            'smart-app-installed', 'smart-app-install-rejected',
            'smart-app-removed', 'smart-app-review-pending',
            'smart-app-metadata-updated',
            'cds.discovery.served',
            'cds.service.registered', 'cds.service.deactivated',
            'cds.hook.fired',
            'cds.card.rendered', 'cds.card.rejected_validation', 'cds.card.suppressed_stale',
            'cds.feedback.accepted', 'cds.feedback.overridden',
            'agentops.action.attempted',
            'agentops.action.allowed',
            'agentops.action.blocked',
            'agentops.action.confirmed',
            'agentops.action.escalated',
            'agentops.action.rolled-back',
            'agentops.policy.loaded',
            'agentops.policy.collision',
            'bulk_export.kickoff.group',
            'bulk_export.kickoff.patient',
            'bulk_export.kickoff.system',
            'bulk_export.complete',
            'bulk_export.cancelled',
            'bulk_export.rejected',
            'patient_access.token.issued',
            'patient_access.token.revoked',
            'capability_statement.served',
            'catalog_sync.frames.bulk.upserted',
            'catalog_sync.frames.bulk.retired',
            'catalog_sync.frames.run.success',
            'catalog_sync.frames.run.failure',
            'catalog_sync.frames.run.partial',
            'catalog_sync.hcpcs.delta.upserted',
            'catalog_sync.hcpcs.delta.retired',
            'catalog_sync.hcpcs.run.success',
            'catalog_sync.hcpcs.run.failure',
            'catalog.frames.export.csv',
            'practice.frames-data-subscription.toggled'
        )
    );
