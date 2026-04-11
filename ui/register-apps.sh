#!/bin/bash
JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxODk0NzYyYi1lYzM3LTQ3YzctOGEyNy0yYzA4ZWRmZmFiZjkiLCJ1c2VybmFtZSI6ImFkbWluIiwibmFtZSI6IkFkbWluIFVzZXIiLCJlbWFpbCI6ImFkbWluQHNraWJpZGkud3RmIiwiaXNBZG1pbiI6dHJ1ZSwiZ3JvdXBzIjpbImFkbWlucyJdLCJleHAiOjE3NzE3NTU4NDB9.U-IFpfsmxsBKBic7Vd-LL_SshElVA5KN_hIVY96bh4Y"
BASE="http://10.248.189.6:3000"

echo "=== Register Wiki ==="
curl -s -X POST \
  -H "Cookie: ye-ui-session=$JWT" \
  -H "Content-Type: application/json" \
  -d '{"id":"ye-wiki","name":"Wiki","container_url":"http://10.248.189.148:3000"}' \
  "$BASE/api/apps/register"
echo ""

echo "=== Register Search ==="
curl -s -X POST \
  -H "Cookie: ye-ui-session=$JWT" \
  -H "Content-Type: application/json" \
  -d '{"id":"ye-search","name":"Search","container_url":"http://10.248.189.198:3000"}' \
  "$BASE/api/apps/register"
echo ""

echo "=== List All Apps ==="
curl -s -H "Cookie: ye-ui-session=$JWT" "$BASE/api/apps/register"
echo ""

echo "=== Info Card Providers ==="
curl -s -H "Cookie: ye-ui-session=$JWT" "$BASE/api/apps/info-cards"
echo ""

echo "=== Widget Declarations ==="
curl -s -H "Cookie: ye-ui-session=$JWT" "$BASE/api/apps/widgets"
echo ""
