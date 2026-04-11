#!/bin/bash
# Setup Authentik OAuth2 provider and application for YouEye-UI
set -e

AUTH_URL="http://10.117.96.54:9000"
TOKEN="434975b72a55d8a288cb2dac8bf99e6ee0265c13"
AUTH_HEADER="Authorization: Bearer $TOKEN"

echo "=== Creating OAuth2 Provider for YouEye-UI ==="

# Get the authorization flow UUID (same as CP uses)
AUTH_FLOW="47be7a53-d4d1-4091-887c-c074bfcce12c"
INVAL_FLOW="1be70f06-b40f-4dc3-a919-4ff4cd136a33"

# Get property mappings (same as CP uses)
PROP_MAPPINGS='["976134ad-d76d-47ad-9393-fbcf34e549ad","4d8df662-8436-42e2-b518-4ef68dd5d65d","8e90230e-bbac-4767-82e9-f5cf947dd1ec","6f4d8f54-c188-4d79-a7a9-2842ecf5fad7","1b1a867f-46b0-48fd-a4c3-57ea6f010110","76f8b2f5-bae0-44f5-80f8-79be1a4dac97","3d2d7dd2-aed1-40b1-ac0d-5c814d10169c"]'

# Create OAuth2 provider
PROVIDER_RESPONSE=$(curl -s -X POST "$AUTH_URL/api/v3/providers/oauth2/" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YouEye UI",
    "authorization_flow": "'"$AUTH_FLOW"'",
    "invalidation_flow": "'"$INVAL_FLOW"'",
    "property_mappings": '"$PROP_MAPPINGS"',
    "client_type": "confidential",
    "client_id": "youeye-ui",
    "redirect_uris": [
      {"matching_mode": "strict", "url": "https://skibidi.wtf/api/auth/callback"},
      {"matching_mode": "strict", "url": "http://skibidi.wtf/api/auth/callback"},
      {"matching_mode": "strict", "url": "http://192.168.31.190:3001/api/auth/callback"}
    ],
    "include_claims_in_id_token": true,
    "sub_mode": "hashed_user_id",
    "issuer_mode": "per_provider"
  }')

echo "Provider response: $PROVIDER_RESPONSE"

PROVIDER_PK=$(echo "$PROVIDER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['pk'])" 2>/dev/null)
CLIENT_SECRET=$(echo "$PROVIDER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_secret'])" 2>/dev/null)

if [ -z "$PROVIDER_PK" ]; then
  echo "ERROR: Failed to create provider"
  exit 1
fi

echo "Provider PK: $PROVIDER_PK"
echo "Client ID: youeye-ui"
echo "Client Secret: $CLIENT_SECRET"

# Create application
echo ""
echo "=== Creating Application ==="
APP_RESPONSE=$(curl -s -X POST "$AUTH_URL/api/v3/core/applications/" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YouEye UI",
    "slug": "youeye-ui",
    "provider": '"$PROVIDER_PK"',
    "launch_url": "https://skibidi.wtf",
    "policy_engine_mode": "any"
  }')

echo "Application response: $APP_RESPONSE"

echo ""
echo "=== DONE ==="
echo "Client ID: youeye-ui"
echo "Client Secret: $CLIENT_SECRET"
echo ""
echo "Save these values for the UI environment configuration!"
