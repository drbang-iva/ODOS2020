export function normalizeApplicationScope(application: {
  scope?: "whole" | "item";
  itemClaimLeaseExpiresAt?: string;
}): "whole" | "item" {
  return application.scope ?? (application.itemClaimLeaseExpiresAt !== undefined ? "item" : "whole");
}
