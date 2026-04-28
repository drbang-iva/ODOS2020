export const V035_WRITE_TOOL_NAMES = [
  "create_episode_of_care",
  "update_episode_of_care",
  "create_condition_with_tier",
  "create_problem_list_condition",
  "update_condition_status",
  "update_condition_tier",
  "update_condition_body_site",
  "update_condition_code",
  "mark_condition_entered_in_error",
  "create_allergy_intolerance",
  "create_smoking_status_observation",
  "create_care_team",
  "create_procedure",
  "update_procedure_body_site",
] as const;

export const V04_WRITE_TOOL_NAMES = [
  "create_lens_device",
  "update_lens_device_properties",
  "create_device_definition",
  "create_concept_map",
  "create_substance",
] as const;

export type V035WriteToolName = (typeof V035_WRITE_TOOL_NAMES)[number];
export type V04WriteToolName = (typeof V04_WRITE_TOOL_NAMES)[number];
export type OsodWriteToolName = V035WriteToolName | V04WriteToolName;

export function auditHeaders(toolName: OsodWriteToolName): { "X-OSOD-Source": string } {
  return { "X-OSOD-Source": `mcp/${toolName}` };
}
