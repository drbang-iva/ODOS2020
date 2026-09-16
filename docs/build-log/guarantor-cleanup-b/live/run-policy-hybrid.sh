#!/usr/bin/env bash
set -euo pipefail
target_root="${1:?target checkout path required}"
action="${2:?dry-run or apply required}"
fixture_root="${3:?synthetic fixture checkout path required}"
set -a
source "$fixture_root/.odos/cleanup-b/runtime.env"
source "$fixture_root/.odos/cleanup-b/github.env"
source "$fixture_root/.odos/operator.env"
set +a
node --import tsx "$(dirname "${BASH_SOURCE[0]}")/sync-policy-hybrid.mjs" "$target_root" "$action"
