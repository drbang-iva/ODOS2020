ALTER TABLE osod_finding_instances
    ADD COLUMN IF NOT EXISTS method JSONB,
    ADD COLUMN IF NOT EXISTS performer_references TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS source_references TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE osod_diagnosis_suggestion_edges
    ADD COLUMN IF NOT EXISTS score NUMERIC(6,3),
    ADD COLUMN IF NOT EXISTS evidence_finding_instance_ids UUID[] NOT NULL DEFAULT '{}';

UPDATE osod_diagnosis_suggestion_edges
SET evidence_finding_instance_ids = ARRAY[source_finding_instance_id]::UUID[]
WHERE source_finding_instance_id IS NOT NULL
  AND evidence_finding_instance_ids = '{}';

UPDATE osod_diagnosis_suggestion_edges
SET score = COALESCE(confidence, 1.0 / NULLIF(rank, 0))
WHERE score IS NULL;

ALTER TABLE osod_diagnosis_suggestion_edges
    ALTER COLUMN score SET NOT NULL,
    ALTER COLUMN visit_state SET DEFAULT 'unreviewed';

ALTER TABLE osod_diagnosis_suggestion_edges
    DROP CONSTRAINT IF EXISTS osod_diagnosis_suggestion_edges_visit_state_check,
    ADD CONSTRAINT osod_diagnosis_suggestion_edges_visit_state_check
        CHECK (visit_state IN ('unreviewed', 'generated', 'shown', 'suppressed', 'accepted', 'rejected', 'expired', 'superseded')),
    DROP CONSTRAINT IF EXISTS osod_diagnosis_suggestion_edges_score_check,
    ADD CONSTRAINT osod_diagnosis_suggestion_edges_score_check
        CHECK (score >= 0),
    DROP CONSTRAINT IF EXISTS osod_diagnosis_suggestion_edges_evidence_check,
    ADD CONSTRAINT osod_diagnosis_suggestion_edges_evidence_check
        CHECK (
            source_finding_instance_id IS NULL OR
            array_length(evidence_finding_instance_ids, 1) IS NOT NULL
        );
