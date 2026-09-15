#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$script_dir/../.." && pwd)"
seed="$script_dir/youeye-seed-market"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

templates="$work/templates"
state="$work/state"
mkdir -p "$templates"
commit=$(jq -er '.market.commit' "$root/appliance/release-lock.json")
repo=$(jq -er '.market.source' "$root/appliance/release-lock.json")
jq -S -n --arg repo "$repo" --arg commit "$commit" \
    '{id:"official",name:"Official YouEye Market",repo_url:$repo,branch:"main",resolved_commit:$commit,bootstrap_commit:$commit,enabled:true,priority:0,trust:"official"}' \
    > "$templates/market-source.json"
jq -S -n --arg repo "$repo" --arg commit "$commit" \
    '{active_sources:[{id:"official",name:"Official YouEye Market",repo_url:$repo,branch:"main",resolved_commit:$commit,bootstrap_commit:$commit,enabled:true,priority:0,trust:"official"}]}' \
    > "$templates/market-sources.json"

YOUEYE_MARKET_TEMPLATE_DIR="$templates" YOUEYE_MARKET_STATE_DIR="$state" "$seed"
cmp -s "$templates/market-source.json" "$state/market-source.json"
cmp -s "$templates/market-sources.json" "$state/market-sources.json"
test "$(stat -c %a "$state")" = 700
test "$(stat -c %a "$state/market-source.json")" = 600
test "$(stat -c %a "$state/market-sources.json")" = 600

printf '{"repo_url":"https://owner.example/Market","branch":"main"}\n' > "$state/market-source.json"
YOUEYE_MARKET_TEMPLATE_DIR="$templates" YOUEYE_MARKET_STATE_DIR="$state" "$seed"
jq -e '.repo_url == "https://owner.example/Market" and .branch == "main"' "$state/market-source.json" >/dev/null

printf 'PASS: branch-based appliance Market seed, exact bootstrap identity, and owner configuration preservation\n'
