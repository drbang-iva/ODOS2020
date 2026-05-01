-- OSOD v0.55a SMART scope intersection decision records.

CREATE TABLE IF NOT EXISTS osod_smart_scope_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    requested_scopes JSONB NOT NULL,
    effective_scopes JSONB NOT NULL,
    policy_id TEXT,
    parameterized_bounds JSONB NOT NULL DEFAULT '{}'::jsonb,
    outcome_class TEXT NOT NULL,
    decided_by TEXT,
    decision_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    expiration_timestamp TIMESTAMPTZ NOT NULL,
    CONSTRAINT osod_smart_scope_decisions_outcome_class_check CHECK (
        outcome_class IN ('granted', 'reduced', 'staged-review', 'rejected')
    )
);

CREATE INDEX IF NOT EXISTS osod_smart_scope_decisions_client_time_idx
    ON osod_smart_scope_decisions (app_client_id, decision_timestamp DESC);

CREATE INDEX IF NOT EXISTS osod_smart_scope_decisions_user_time_idx
    ON osod_smart_scope_decisions (user_id, decision_timestamp DESC);
