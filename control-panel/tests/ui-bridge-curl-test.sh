#!/bin/bash
#
# UI Bridge API Test Script
#
# Tests all /api/ui-bridge/* endpoints using curl.
# Run on the VM or any machine that can reach the CP.
#
# Usage:
#   ./tests/ui-bridge-curl-test.sh [token]
#
# If no token is provided, reads from /etc/youeye/ui-bridge-token

set -euo pipefail

CP_URL="${CP_URL:-http://localhost:3000}"
TOKEN="${1:-}"

if [ -z "$TOKEN" ]; then
  if [ -f /etc/youeye/ui-bridge-token ]; then
    TOKEN=$(cat /etc/youeye/ui-bridge-token)
  else
    echo "ERROR: No token provided and /etc/youeye/ui-bridge-token not found"
    exit 1
  fi
fi

PASSED=0
FAILED=0

test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local data="${4:-}"
  local expected_status="${5:-200}"

  printf "  [TEST] %-50s" "$name..."

  local args=(-s -o /tmp/bridge-test-response.json -w "%{http_code}" \
    -H "X-UI-Bridge-Token: $TOKEN" \
    -X "$method")

  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi

  local status
  status=$(curl "${args[@]}" "${CP_URL}${path}" 2>/dev/null) || status="000"

  if [ "$status" = "$expected_status" ]; then
    echo "✅ PASS (HTTP $status)"
    PASSED=$((PASSED + 1))
  else
    echo "❌ FAIL (expected $expected_status, got $status)"
    cat /tmp/bridge-test-response.json 2>/dev/null || true
    echo ""
    FAILED=$((FAILED + 1))
  fi
}

echo ""
echo "=== UI Bridge API Tests ==="
echo "Target: $CP_URL"
echo "Token: ${TOKEN:0:8}..."
echo ""

echo "--- Authentication ---"
test_endpoint "Auth with valid token" POST "/api/ui-bridge/auth" "" "200"
test_endpoint "Auth with invalid token" POST "/api/ui-bridge/auth"

# Override token for invalid test
printf "  [TEST] %-50s" "Auth with bad token..."
status=$(curl -s -o /tmp/bridge-test-response.json -w "%{http_code}" \
  -H "X-UI-Bridge-Token: bad-token" \
  -X POST "${CP_URL}/api/ui-bridge/auth" 2>/dev/null) || status="000"
if [ "$status" = "401" ]; then
  echo "✅ PASS (HTTP $status)"
  PASSED=$((PASSED + 1))
else
  echo "❌ FAIL (expected 401, got $status)"
  FAILED=$((FAILED + 1))
fi

printf "  [TEST] %-50s" "Auth with no token..."
status=$(curl -s -o /tmp/bridge-test-response.json -w "%{http_code}" \
  -X POST "${CP_URL}/api/ui-bridge/auth" 2>/dev/null) || status="000"
if [ "$status" = "401" ]; then
  echo "✅ PASS (HTTP $status)"
  PASSED=$((PASSED + 1))
else
  echo "❌ FAIL (expected 401, got $status)"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "--- System ---"
test_endpoint "System overview" GET "/api/ui-bridge/system"

echo ""
echo "--- Containers ---"
test_endpoint "Container list" GET "/api/ui-bridge/containers"

echo ""
echo "--- DNS ---"
test_endpoint "DNS stats" GET "/api/ui-bridge/dns/stats"
test_endpoint "DNS control (invalid action)" POST "/api/ui-bridge/dns/control" '{"action":"invalid"}' "400"

echo ""
echo "--- Proxy ---"
test_endpoint "Proxy routes" GET "/api/ui-bridge/proxy/routes"

echo ""
echo "--- Users ---"
test_endpoint "Users list" GET "/api/ui-bridge/users"

echo ""
echo "--- Updates ---"
test_endpoint "Updates check" GET "/api/ui-bridge/updates"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
