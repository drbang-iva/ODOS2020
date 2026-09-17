# W138 canonical Deferred visibility

Operator authorization in this session: **Expose canonical Deferred (recommended)**, in response to the explicit question identifying the conflict between §13 and the legacy flag-only UI assertion.

Observed before: every shipped Ocular Health definition has the old allowDeferred flag false. The settings endpoint only enables that flag for Dilation. The canonical Ocular Health save route branches before the legacy flag validation and accepts panel.deferred under §13. Consequently the implemented canonical Deferred state could not be reached on the actual shipped Ocular Health screen.

Authorized bounded change: OcularHealthSection exposes Deferred for canonical Ocular Health panels independently of the legacy definition flag. No MCP, role, stored policy, or definition seed change. Existing `ocular-health deferral controls come only from each definition's allowDeferred flag` becomes `W138 canonical ocular panels expose Deferred independently of the legacy definition flag`; its exact count changes from2 to4 for two bilateral definitions, one legacy-enabled and one legacy-disabled. Mapping: W138 and the explicit operator answer above. All selection-preservation and locking assertions remain.

Red/green output and the actual shipped-definition browser screenshot will accompany this record. This file records implementation authorization/evidence, not a new strategy decision.
