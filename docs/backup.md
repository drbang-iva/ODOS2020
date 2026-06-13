# OSOD Local Backup and At-Rest Encryption

OSOD backups are local files. Use the practice's own filesystem or attached drive, then protect that destination with host-level at-rest encryption and physical safeguards.

The practice is the responsible actor for physical safeguards around devices and media. Ledger row 46 verifies HIPAA 45 CFR §164.310 and HHS physical-safeguard guidance.

## Supported Host Encryption Paths

| Host | Practice-controlled option | Primary-source references |
|---|---|---|
| Linux | LUKS / dm-crypt volume for the backup destination. | Ledger row 48: cryptsetup project README and LUKS2 on-disk format documentation. |
| macOS | FileVault for the Mac, or Disk Utility encrypted APFS external storage. | Ledger row 49: Apple FileVault user guide and Apple Disk Utility encrypted storage guide. |
| Windows host | BitLocker on the backup volume. | Ledger row 50: Microsoft BitLocker overview and BitLocker FAQ. |

The helper script does not enforce encryption. It emits warnings so the practice can review the destination before live patient data.

## Verify a Destination

```bash
npm run verify-backup-destination -- /path/to/osod-backups
```

The report checks:

- Destination path exists or can be created.
- Destination is writable.
- Available space is at least 2x the current local Postgres/Binary/DR fixture footprint when that footprint can be measured.
- Linux/macOS/Windows encryption heuristics report a likely encrypted destination, or warn when they cannot confirm one.

Example warning:

```text
Could not confirm FileVault/APFS encryption for this macOS backup destination.
```

That warning is not a hard block. It is a handoff to the practice's hardware owner or IT contact.

## Backup and Restore Drill

The operator wrapper runs the broad v0.5b restore drill plus the v0.6a frames-table drill. See [`docs/dr-drill.md`](dr-drill.md).

```bash
npm run dr-drill
```

Operator-only outline:

```bash
docker-compose -p osod-dr-drill -f docker-compose.dr-drill.yml up -d
npx tsx scripts/seed-dr-drill.ts
OSOD_BACKUP_DIR="$PWD/backup-dr-drill" scripts/backup.sh
docker-compose -p osod-dr-drill -f docker-compose.dr-drill.yml down -v
docker-compose -p osod-dr-drill -f docker-compose.dr-drill.yml up -d
scripts/restore.sh "$PWD/backup-dr-drill/manifest-<timestamp>.json"
```

The restore integrity suite verifies audit rows, signed Provenance samples, Binary security context, AuditEvent projection coverage, and AccessPolicy / ProjectMembership round-trip status.

## Operational Notes

- Keep backup media physically controlled by the practice.
- Do not store backup manifests or media in the repo.
- Do not commit `.osod/`, `.osod-setup-state.json`, `.env`, backup directories, or restored data volumes.
- Run `npm run preflight` after setup and before live use so env-var PHI hard-blocks are caught early.
