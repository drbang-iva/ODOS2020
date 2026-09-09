WITH records AS (
 SELECT content::jsonb AS doc FROM "Observation" WHERE deleted = false
), states AS (
 SELECT doc, c->>'valueString' AS state FROM records
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(doc->'component','[]'::jsonb)) c
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c->'code'->'coding','[]'::jsonb)) code WHERE code->>'code' = 'EXAM_STATE')
)
SELECT 'active_observations', count(*) FROM records
UNION ALL SELECT 'observations_with_EXAM_STATE', count(DISTINCT doc->>'id') FROM states
UNION ALL SELECT 'deferred_observations_all_definitions', count(DISTINCT doc->>'id') FROM states WHERE state='deferred'
UNION ALL SELECT 'impossible_state_negative_control', count(*) FROM states WHERE state='DEFER_1_IMPOSSIBLE';
WITH synthetic(doc) AS (VALUES ('{"component":[{"code":{"coding":[{"code":"EXAM_STATE"}]},"valueString":"deferred"}]}'::jsonb)), states AS (
SELECT c->>'valueString' AS state FROM synthetic CROSS JOIN LATERAL jsonb_array_elements(doc->'component') c
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c->'code'->'coding') code WHERE code->>'code'='EXAM_STATE')
)
SELECT 'synthetic_deferred_positive_control', count(*) FROM states WHERE state='deferred'
UNION ALL SELECT 'synthetic_impossible_negative_control',count(*) FROM states WHERE state='DEFER_1_IMPOSSIBLE';
