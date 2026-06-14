CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS osod_clinical_finding_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stable_key TEXT NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z0-9][a-z0-9_-]*$'),
    display TEXT NOT NULL CHECK (display <> ''),
    section_key TEXT,
    anatomy_target TEXT CHECK (anatomy_target IN ('eye', 'optic-nerve', 'cornea', 'retina', 'other') OR anatomy_target IS NULL),
    value_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    normal_semantics JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_status TEXT NOT NULL DEFAULT 'unseeded-needs-operator-input'
        CHECK (source_status IN ('verified-seed', 'unseeded-needs-operator-input', 'local-practice')),
    fhir_observation_code JSONB,
    not_bill_ready BOOLEAN NOT NULL DEFAULT true,
    active BOOLEAN NOT NULL DEFAULT true,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osod_finding_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finding_definition_id UUID NOT NULL REFERENCES osod_clinical_finding_definitions(id),
    patient_reference TEXT NOT NULL CHECK (patient_reference ~ '^Patient/.+'),
    encounter_reference TEXT NOT NULL CHECK (encounter_reference ~ '^Encounter/.+'),
    observation_reference TEXT UNIQUE,
    laterality TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (laterality IN ('OD', 'OS', 'OU', 'UNKNOWN')),
    finding_value JSONB NOT NULL,
    interpretation TEXT CHECK (interpretation IN ('normal', 'abnormal', 'borderline', 'unknown') OR interpretation IS NULL),
    source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'device', 'parser', 'agent', 'protocol')),
    confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_finding_instances_patient_encounter
    ON osod_finding_instances (patient_reference, encounter_reference);
CREATE INDEX IF NOT EXISTS idx_finding_instances_definition
    ON osod_finding_instances (finding_definition_id);

CREATE TABLE IF NOT EXISTS osod_diagnosis_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stable_key TEXT NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z0-9][a-z0-9_-]*$'),
    display TEXT NOT NULL CHECK (display <> ''),
    clinical_family TEXT NOT NULL CHECK (clinical_family <> ''),
    icd10_family TEXT,
    icd10_code TEXT CHECK (icd10_code IS NULL OR icd10_code ~ '^[A-Z][0-9][0-9A-Z](\\.[0-9A-Z]{1,4})?$'),
    icd10_display TEXT,
    coding_status TEXT NOT NULL DEFAULT 'placeholder'
        CHECK (coding_status IN ('verified', 'placeholder', 'provisional')),
    CONSTRAINT verified_diagnosis_requires_icd10_code CHECK (
        coding_status <> 'verified' OR icd10_code IS NOT NULL
    ),
    laterality_required BOOLEAN NOT NULL DEFAULT false,
    applicable_finding_definition_ids UUID[] NOT NULL DEFAULT '{}',
    separates_severity_stage_payer_risk BOOLEAN NOT NULL DEFAULT true,
    active BOOLEAN NOT NULL DEFAULT true,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osod_diagnosis_suggestion_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_finding_definition_id UUID REFERENCES osod_clinical_finding_definitions(id),
    source_finding_instance_id UUID REFERENCES osod_finding_instances(id),
    target_diagnosis_definition_id UUID NOT NULL REFERENCES osod_diagnosis_definitions(id),
    predicate_key TEXT NOT NULL CHECK (predicate_key <> ''),
    predicate_expression JSONB NOT NULL DEFAULT '{}'::jsonb,
    rank INTEGER NOT NULL CHECK (rank >= 1),
    confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    explanation TEXT NOT NULL CHECK (explanation <> ''),
    rule_version TEXT,
    visit_state TEXT NOT NULL DEFAULT 'generated'
        CHECK (visit_state IN ('generated', 'shown', 'suppressed', 'accepted', 'rejected', 'expired', 'superseded')),
    accepted_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT suggestion_edge_requires_source CHECK (
        source_finding_definition_id IS NOT NULL OR source_finding_instance_id IS NOT NULL
    ),
    CONSTRAINT suggestion_edge_single_visit_resolution CHECK (
        NOT (accepted_at IS NOT NULL AND rejected_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_suggestion_edges_instance
    ON osod_diagnosis_suggestion_edges (source_finding_instance_id);
CREATE INDEX IF NOT EXISTS idx_suggestion_edges_target
    ON osod_diagnosis_suggestion_edges (target_diagnosis_definition_id);

CREATE TABLE IF NOT EXISTS osod_encounter_diagnoses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diagnosis_definition_id UUID NOT NULL REFERENCES osod_diagnosis_definitions(id),
    patient_reference TEXT NOT NULL CHECK (patient_reference ~ '^Patient/.+'),
    encounter_reference TEXT NOT NULL CHECK (encounter_reference ~ '^Encounter/.+'),
    condition_reference TEXT UNIQUE,
    clinical_status TEXT NOT NULL DEFAULT 'active'
        CHECK (clinical_status IN ('active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved')),
    verification_status TEXT NOT NULL DEFAULT 'unconfirmed'
        CHECK (verification_status IN ('unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered-in-error')),
    diagnosis_rank INTEGER NOT NULL CHECK (diagnosis_rank >= 1),
    laterality TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (laterality IN ('OD', 'OS', 'OU', 'UNKNOWN')),
    clinical_severity TEXT,
    disease_stage TEXT,
    payer_risk_bucket TEXT,
    clinician_note TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmed_at TIMESTAMPTZ,
    CONSTRAINT encounter_diagnosis_confirmation_gate CHECK (
        (verification_status = 'confirmed' AND confirmed_at IS NOT NULL) OR
        (verification_status <> 'confirmed' AND confirmed_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS osod_encounter_diagnosis_evidence (
    encounter_diagnosis_id UUID NOT NULL REFERENCES osod_encounter_diagnoses(id) ON DELETE CASCADE,
    finding_instance_id UUID NOT NULL REFERENCES osod_finding_instances(id),
    evidence_role TEXT NOT NULL DEFAULT 'supporting' CHECK (evidence_role IN ('supporting', 'refuting', 'context')),
    PRIMARY KEY (encounter_diagnosis_id, finding_instance_id, evidence_role)
);

CREATE INDEX IF NOT EXISTS idx_encounter_diagnosis_evidence_finding
    ON osod_encounter_diagnosis_evidence (finding_instance_id);

CREATE TABLE IF NOT EXISTS osod_protocol_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stable_key TEXT NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z0-9][a-z0-9_-]*$'),
    display TEXT NOT NULL CHECK (display <> ''),
    diagnosis_definition_id UUID REFERENCES osod_diagnosis_definitions(id),
    source_status TEXT NOT NULL DEFAULT 'unseeded-needs-operator-input'
        CHECK (source_status IN ('verified-seed', 'unseeded-needs-operator-input', 'local-practice')),
    action_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
    not_bill_ready BOOLEAN NOT NULL DEFAULT true,
    active BOOLEAN NOT NULL DEFAULT true,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osod_plan_action_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_definition_id UUID REFERENCES osod_protocol_definitions(id),
    encounter_diagnosis_id UUID REFERENCES osod_encounter_diagnoses(id),
    linked_finding_instance_ids UUID[] NOT NULL DEFAULT '{}',
    action_key TEXT NOT NULL CHECK (action_key <> ''),
    action_kind TEXT NOT NULL CHECK (action_kind IN ('finding-prompt', 'plan-text', 'order', 'procedure', 'education', 'follow-up', 'charge-proposal')),
    state TEXT NOT NULL DEFAULT 'selected' CHECK (state IN ('selected', 'removed', 'modified', 'deferred')),
    merge_key TEXT,
    generated_fhir_reference TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osod_procedure_charge_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diagnosis_definition_id UUID REFERENCES osod_diagnosis_definitions(id),
    diagnosis_family TEXT,
    procedure_system TEXT NOT NULL CHECK (procedure_system <> ''),
    procedure_code TEXT NOT NULL CHECK (procedure_code <> ''),
    payer_context TEXT,
    jurisdiction TEXT,
    support_status TEXT NOT NULL DEFAULT 'needs-review'
        CHECK (support_status IN ('allowed', 'needs-review', 'not-allowed', 'warn-only', 'provisional')),
    source_authority TEXT NOT NULL CHECK (source_authority <> ''),
    effective_from DATE,
    effective_to DATE,
    required_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    laterality_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    verification_status TEXT NOT NULL DEFAULT 'provisional'
        CHECK (verification_status IN ('verified', 'provisional', 'placeholder')),
    not_bill_ready BOOLEAN NOT NULL DEFAULT true,
    source_url TEXT,
    access_date DATE,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osod_charge_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_action_instance_id UUID REFERENCES osod_plan_action_instances(id),
    procedure_system TEXT NOT NULL CHECK (procedure_system <> ''),
    procedure_code TEXT NOT NULL CHECK (procedure_code <> ''),
    linked_encounter_diagnosis_ids UUID[] NOT NULL DEFAULT '{}',
    evidence_finding_instance_ids UUID[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'suggested'
        CHECK (status IN ('suggested', 'selected', 'removed', 'overridden', 'staged')),
    coverage_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    selected BOOLEAN NOT NULL DEFAULT false,
    override_reason TEXT,
    charge_item_reference TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
