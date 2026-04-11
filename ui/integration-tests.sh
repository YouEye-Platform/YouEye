#!/bin/bash
JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxODk0NzYyYi1lYzM3LTQ3YzctOGEyNy0yYzA4ZWRmZmFiZjkiLCJ1c2VybmFtZSI6ImFkbWluIiwibmFtZSI6IkFkbWluIFVzZXIiLCJlbWFpbCI6ImFkbWluQHNraWJpZGkud3RmIiwiaXNBZG1pbiI6dHJ1ZSwiZ3JvdXBzIjpbImFkbWlucyJdLCJleHAiOjE3NzE3NTU4NDB9.U-IFpfsmxsBKBic7Vd-LL_SshElVA5KN_hIVY96bh4Y"
BASE="http://10.248.189.6:3000"
PASS=0
FAIL=0

test_api() {
  local name="$1"
  local expected_code="$2"
  local method="$3"
  local url="$4"
  local body="$5"
  
  if [ -n "$body" ]; then
    RESP=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Cookie: ye-ui-session=$JWT" \
      -H "Content-Type: application/json" \
      -d "$body" "$BASE$url")
  else
    RESP=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Cookie: ye-ui-session=$JWT" "$BASE$url")
  fi
  
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | head -n -1)
  
  if [ "$CODE" = "$expected_code" ]; then
    echo "PASS: $name (HTTP $CODE)"
    PASS=$((PASS+1))
  else
    echo "FAIL: $name (Expected $expected_code, got $CODE)"
    echo "  Body: $BODY"
    FAIL=$((FAIL+1))
  fi
  echo "  Response: $(echo $BODY | head -c 200)"
}

echo "============================================"
echo "  Phase 2 Integration Tests"
echo "============================================"
echo ""

# Test 1: App details
test_api "T1: Get Wiki app details" "200" "GET" "/api/apps/ye-wiki"

# Test 2: Get Search app details
test_api "T2: Get Search app details" "200" "GET" "/api/apps/ye-search"

# Test 3: Health check via API
test_api "T3: Health check Wiki via API" "200" "PUT" "/api/apps/ye-wiki" '{"action":"health-check"}'

# Test 4: Health check Search via API
test_api "T4: Health check Search via API" "200" "PUT" "/api/apps/ye-search" '{"action":"health-check"}'

# Test 5: Refresh manifest via API
test_api "T5: Refresh Wiki manifest" "200" "PUT" "/api/apps/ye-wiki" '{"action":"refresh-manifest"}'

# Test 6: Get manifest endpoint
test_api "T6: Get Wiki manifest from API" "200" "GET" "/api/apps/ye-wiki/manifest"

# Test 7: Widget data proxy - featured article
test_api "T7: Widget data - featured article" "200" "GET" "/api/widgets/app-data?app=ye-wiki&widget=featured-article"

# Test 8: Widget data proxy - today in history
test_api "T8: Widget data - today in history" "200" "GET" "/api/widgets/app-data?app=ye-wiki&widget=today-in-history"

# Test 9: Widget data proxy - search bar
test_api "T9: Widget data - search bar" "200" "GET" "/api/widgets/app-data?app=ye-search&widget=search-bar"

# Test 10: Info card request for Wikipedia URL
test_api "T10: Info card for Wikipedia URL" "200" "POST" "/api/apps/info-card" '{"url":"https://en.wikipedia.org/wiki/Linux"}'

# Test 11: List info card providers
test_api "T11: Info card providers list" "200" "GET" "/api/apps/info-cards"

# Test 12: List widget declarations
test_api "T12: Widget declarations" "200" "GET" "/api/apps/widgets"

# Test 13: List all apps
test_api "T13: List all apps" "200" "GET" "/api/apps/register"

# Test 14: Non-existent app - should 404
test_api "T14: Non-existent app (404)" "404" "GET" "/api/apps/nonexistent"

# Test 15: Wiki app homepage (direct)
echo ""
echo "=== Direct App Tests ==="
WIKI_RESP=$(curl -s -w "\n%{http_code}" http://10.248.189.148:3000/)
WIKI_CODE=$(echo "$WIKI_RESP" | tail -1)
if [ "$WIKI_CODE" = "200" ]; then
  echo "PASS: T15: Wiki homepage loads (HTTP 200)"
  PASS=$((PASS+1))
else  
  echo "FAIL: T15: Wiki homepage (HTTP $WIKI_CODE)"
  FAIL=$((FAIL+1))
fi

# Test 16: Search homepage (direct)
SEARCH_RESP=$(curl -s -w "\n%{http_code}" http://10.248.189.198:3000/)
SEARCH_CODE=$(echo "$SEARCH_RESP" | tail -1)
if [ "$SEARCH_CODE" = "200" ]; then
  echo "PASS: T16: Search homepage loads (HTTP 200)"
  PASS=$((PASS+1))
else
  echo "FAIL: T16: Search homepage (HTTP $SEARCH_CODE)"
  FAIL=$((FAIL+1))
fi

# Test 17: Wiki search API (direct)
WIKI_SEARCH=$(curl -s -w "\n%{http_code}" "http://10.248.189.148:3000/api/wiki/search?q=linux")
WS_CODE=$(echo "$WIKI_SEARCH" | tail -1)
if [ "$WS_CODE" = "200" ]; then
  echo "PASS: T17: Wiki search API works (HTTP 200)"
  PASS=$((PASS+1))
else
  echo "FAIL: T17: Wiki search API (HTTP $WS_CODE)"
  FAIL=$((FAIL+1))
fi

# Test 18: Wiki article summary (direct)
WIKI_SUM=$(curl -s -w "\n%{http_code}" "http://10.248.189.148:3000/api/wiki/summary/Linux")
WSUM_CODE=$(echo "$WIKI_SUM" | tail -1)
if [ "$WSUM_CODE" = "200" ]; then
  echo "PASS: T18: Wiki article summary works (HTTP 200)"
  PASS=$((PASS+1))
else
  echo "FAIL: T18: Wiki article summary (HTTP $WSUM_CODE)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "============================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================"
