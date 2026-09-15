#!/bin/sh
set -eu

root=${1:-$(git rev-parse --show-toplevel)}
cd "$root"

failed=0
report() {
    printf '%s\n' "$1" >&2
    failed=1
}

for forbidden in AGENTS.md CLAUDE.md CLAUDE.local.md; do
    if [ -e "$forbidden" ] && git ls-files --error-unmatch "$forbidden" >/dev/null 2>&1; then
        report "public release hygiene: tracked worker instruction file: $forbidden"
    fi
done

patterns='git\.potemk\.in|/workspace/\.anyagent|@workers\.anyagent\.local|@youeye\.local|alloc-app-network-isolation-ipam-[0-9]+'
files=$(git ls-files | grep -Ev '^(scripts/check-public-release-hygiene(_test)?\.sh|pnpm-lock\.yaml|control-panel/pnpm-lock\.yaml|ui/pnpm-lock\.yaml)$' || true)
if [ -n "$files" ]; then
    matches=$(printf '%s\n' "$files" | while IFS= read -r file; do [ ! -f "$file" ] || grep -nEI "$patterns" "$file" || true; done)
    if [ -n "$matches" ]; then
        printf '%s\n' "$matches" >&2
        report 'public release hygiene: private operational identifiers found'
    fi
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi
printf '%s\n' 'public release hygiene passed'
