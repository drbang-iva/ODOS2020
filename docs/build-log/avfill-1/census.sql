BEGIN READ ONLY;
WITH observations AS (
  SELECT id, deleted, CASE WHEN content IS JSON OBJECT THEN content::jsonb ELSE NULL END AS resource FROM "Observation"
), components AS (
  SELECT o.id, o.deleted, c AS component
  FROM observations o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.resource->'component', '[]'::jsonb)) c
), matches AS (
  SELECT id, deleted, component,
    EXISTS (SELECT 1 FROM jsonb_array_elements(component->'code'->'coding') code WHERE code->>'code' IN ('CUSTOM_GRADE_A_V_RATIO', 'OD_CUSTOM_GRADE_A_V_RATIO', 'OS_CUSTOM_GRADE_A_V_RATIO')) AS av,
    EXISTS (SELECT 1 FROM jsonb_array_elements(component->'code'->'coding') code WHERE code->>'code' ~ '^(OD_|OS_)?CUSTOM_') AS custom,
    EXISTS (SELECT 1 FROM jsonb_array_elements(component->'code'->'coding') code WHERE code->>'code' = 'SPHERE') AS sphere,
    EXISTS (SELECT 1 FROM jsonb_array_elements(component->'code'->'coding') code WHERE code->>'code' = 'AVFILL_IMPOSSIBLE_739604ae') AS impossible
  FROM components
)
SELECT
  (SELECT count(*) FROM observations WHERE NOT deleted) AS current_rows,
  (SELECT count(*) FROM observations WHERE NOT deleted AND resource IS NOT NULL) AS parseable_current_observations,
  (SELECT count(*) FROM observations WHERE deleted) AS deleted_observations,
  count(DISTINCT id) FILTER (WHERE NOT deleted) AS positive_any_component,
  count(DISTINCT id) FILTER (WHERE NOT deleted AND custom) AS positive_custom_component,
  count(DISTINCT id) FILTER (WHERE NOT deleted AND sphere) AS positive_exact_sphere,
  count(DISTINCT id) FILTER (WHERE NOT deleted AND av) AS av_observations,
  count(DISTINCT id) FILTER (WHERE NOT deleted AND av AND (
    component->>'valueString' IN ('2-3', '2:3') OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(component->'valueCodeableConcept'->'coding', '[]'::jsonb)) value WHERE value->>'code' IN ('2-3', '2:3'))
  )) AS default_value_observations,
  count(DISTINCT id) FILTER (WHERE NOT deleted AND impossible) AS negative_impossible
FROM matches;
ROLLBACK;
