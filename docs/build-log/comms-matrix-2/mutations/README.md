# Author mutation evidence

Every mutation has its exact patch, captured landed-source verification, complete red output, and complete restored output. The manifest records each actual test command, working directory, counts, and independently captured process exit. These are author guards, not an independent evaluation.

[Machine-readable manifest](manifest.json) · [Final-source patch checks](patch-checks.log)

M5a and M5b supersede the original location-only M5: returned Patient resource versions and disagreement handling are the final contract. The obsolete M5 packet is intentionally excluded.

Counts reflect the tests present when each guard ran. In particular M2, M3, M4 and M15 ran against nine concurrency tests, before two additional read guards were added. These historical focused counts are not final full-suite counts. All patches still apply to the recorded current source without changing mutation logic; no mutations were re-executed for this packaging task.

Absolute checkout prefixes and trailing whitespace have been removed from log output; mutation patch context is preserved verbatim. Test assertions, failure details, counts, and exit values are preserved. No source files were changed during packaging.

| Guard | Red passed/total | Restored passed/total | Evidence |
|---|---|---|---|
| M1 | 11/15, exit 1 | 15/15, exit 0 | [diff](M1.diff) · [landed](M1-landed.log) · [red](M1-red.log) · [restored](M1-green.log) |
| M2 | 5/9, exit 1 | 9/9, exit 0 | [diff](M2.diff) · [landed](M2-landed.log) · [red](M2-red.log) · [restored](M2-green.log) |
| M3 | 8/9, exit 1 | 9/9, exit 0 | [diff](M3.diff) · [landed](M3-landed.log) · [red](M3-red.log) · [restored](M3-green.log) |
| M4 | 8/9, exit 1 | 9/9, exit 0 | [diff](M4.diff) · [landed](M4-landed.log) · [red](M4-red.log) · [restored](M4-green.log) |
| M5a | 102/111, exit 1 | 111/111, exit 0 | [diff](M5a.diff) · [landed](M5a-landed.log) · [red](M5a-red.log) · [restored](M5a-green.log) |
| M5b | 108/111, exit 1 | 111/111, exit 0 | [diff](M5b.diff) · [landed](M5b-landed.log) · [red](M5b-red.log) · [restored](M5b-green.log) |
| M6 | 19/20, exit 1 | 20/20, exit 0 | [diff](M6.diff) · [landed](M6-landed.log) · [red](M6-red.log) · [restored](M6-green.log) |
| M7-all | 17/22, exit 1 | 22/22, exit 0 | [diff](M7-all.diff) · [landed](M7-all-landed.log) · [red](M7-all-red.log) · [restored](M7-all-green.log) |
| M7-none | 18/22, exit 1 | 22/22, exit 0 | [diff](M7-none.diff) · [landed](M7-none-landed.log) · [red](M7-none-red.log) · [restored](M7-none-green.log) |
| M8 | 28/31, exit 1 | 31/31, exit 0 | [diff](M8.diff) · [landed](M8-landed.log) · [red](M8-red.log) · [restored](M8-green.log) |
| M9-email | 30/31, exit 1 | 31/31, exit 0 | [diff](M9-email.diff) · [landed](M9-email-landed.log) · [red](M9-email-red.log) · [restored](M9-email-green.log) |
| M9-note | 30/31, exit 1 | 31/31, exit 0 | [diff](M9-note.diff) · [landed](M9-note-landed.log) · [red](M9-note-red.log) · [restored](M9-note-green.log) |
| M9-text | 30/31, exit 1 | 31/31, exit 0 | [diff](M9-text.diff) · [landed](M9-text-landed.log) · [red](M9-text-red.log) · [restored](M9-text-green.log) |
| M10-failed | 29/31, exit 1 | 31/31, exit 0 | [diff](M10-failed.diff) · [landed](M10-failed-landed.log) · [red](M10-failed-red.log) · [restored](M10-failed-green.log) |
| M10-success | 30/31, exit 1 | 31/31, exit 0 | [diff](M10-success.diff) · [landed](M10-success-landed.log) · [red](M10-success-red.log) · [restored](M10-success-green.log) |
| M10-withheld | 27/31, exit 1 | 31/31, exit 0 | [diff](M10-withheld.diff) · [landed](M10-withheld-landed.log) · [red](M10-withheld-red.log) · [restored](M10-withheld-green.log) |
| M11-evidenceStatus | 12/13, exit 1 | 13/13, exit 0 | [diff](M11-evidenceStatus.diff) · [landed](M11-evidenceStatus-landed.log) · [red](M11-evidenceStatus-red.log) · [restored](M11-evidenceStatus-green.log) |
| M11-patientVersion | 11/13, exit 1 | 13/13, exit 0 | [diff](M11-patientVersion.diff) · [landed](M11-patientVersion-landed.log) · [red](M11-patientVersion-red.log) · [restored](M11-patientVersion-green.log) |
| M11-source | 11/13, exit 1 | 13/13, exit 0 | [diff](M11-source.diff) · [landed](M11-source-landed.log) · [red](M11-source-red.log) · [restored](M11-source-green.log) |
| M12-banner | 0/1, exit 1 | 1/1, exit 0 | [diff](M12-banner.diff) · [landed](M12-banner-landed.log) · [red](M12-banner-red.log) · [restored](M12-banner-green.log) |
| M12-cursor | 0/1, exit 1 | 1/1, exit 0 | [diff](M12-cursor.diff) · [landed](M12-cursor-landed.log) · [red](M12-cursor-red.log) · [restored](M12-cursor-green.log) |
| M13 | 3/4, exit 1 | 4/4, exit 0 | [diff](M13.diff) · [landed](M13-landed.log) · [red](M13-red.log) · [restored](M13-green.log) |
| M14 | 14/15, exit 1 | 15/15, exit 0 | [diff](M14.diff) · [landed](M14-landed.log) · [red](M14-red.log) · [restored](M14-green.log) |
| M15 | 8/9, exit 1 | 9/9, exit 0 | [diff](M15.diff) · [landed](M15-landed.log) · [red](M15-red.log) · [restored](M15-green.log) |
