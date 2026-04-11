#!/bin/bash
# Deploy YouEye-UI to an Incus container
set -e

CONTAINER="youeye-ui"
POSTGRES_IP="10.117.96.115"
AUTHENTIK_IP="10.117.96.54"

echo "=== Step 1: Create container ==="
if incus info $CONTAINER &>/dev/null; then
  echo "Container exists, stopping and deleting..."
  incus stop $CONTAINER --force 2>/dev/null || true
  incus delete $CONTAINER --force 2>/dev/null || true
fi

incus launch images:debian/12 $CONTAINER
echo "Waiting for container to start..."
sleep 5

# Wait for network
for i in $(seq 1 30); do
  if incus exec $CONTAINER -- ping -c1 -W1 8.8.8.8 &>/dev/null; then
    break
  fi
  sleep 1
done

echo "=== Step 2: Install Node.js 22 ==="
incus exec $CONTAINER -- bash -c "
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  corepack enable
  corepack prepare pnpm@latest --activate
  node -v
  pnpm -v
"

echo "=== Step 3: Copy source and build ==="
incus exec $CONTAINER -- mkdir -p /opt/ye-ui
incus file push /tmp/ye-ui-src.tar $CONTAINER/tmp/ye-ui-src.tar
incus exec $CONTAINER -- bash -c "cd /opt/ye-ui && tar -xf /tmp/ye-ui-src.tar"

incus exec $CONTAINER -- bash -c "
  cd /opt/ye-ui
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  pnpm run build
"

echo "=== Step 4: Prepare standalone deployment ==="
incus exec $CONTAINER -- bash -c "
  rm -rf /opt/app
  mkdir -p /opt/app
  # Copy all files including hidden .next directory
  cp -r /opt/ye-ui/.next/standalone/. /opt/app/
  # Copy static assets into the standalone .next directory
  cp -r /opt/ye-ui/.next/static /opt/app/.next/static
  # Copy public directory if it exists
  cp -r /opt/ye-ui/public /opt/app/public 2>/dev/null || mkdir -p /opt/app/public
  ls -la /opt/app/
  ls -la /opt/app/.next/
"

echo "=== Step 5: Create systemd service ==="
UI_CONTAINER_IP=$(incus list $CONTAINER --format csv -c 4 | head -1 | cut -d' ' -f1)

cat > /tmp/youeye-ui.service << 'EOF'
[Unit]
Description=YouEye UI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/app
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=0.0.0.0
Environment=UI_EXTERNAL_URL=http://192.168.31.190:3001
Environment=AUTHENTIK_URL=http://AUTHENTIK_IP:9000
Environment=AUTHENTIK_INTERNAL_URL=http://AUTHENTIK_IP:9000
Environment=AUTHENTIK_CLIENT_ID=youeye-ui
Environment=AUTHENTIK_CLIENT_SECRET=4HGnZrb76AotwRXQm6O1UALma4HbnHfKHMzkOjc2lU1YkRARqTII3jjlOxnPq7Poyqqo2076y56tAtnkv00zAHjzQgOou98HwZNX5ohfdEIa0MSO0z9pgor4BKmNCNUE
Environment=JWT_SECRET=YeUiJwtSecret2025VeryLongStringForSecurity1234567890abcdef
Environment=DATABASE_URL=postgresql://youeye:youeye_ui_2025@POSTGRES_IP:5432/youeye
Environment=SECURE_COOKIES=false
ExecStart=/usr/bin/node /opt/app/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Replace IP placeholders
sed -i "s/AUTHENTIK_IP/$AUTHENTIK_IP/g" /tmp/youeye-ui.service
sed -i "s/POSTGRES_IP/$POSTGRES_IP/g" /tmp/youeye-ui.service

incus file push /tmp/youeye-ui.service $CONTAINER/etc/systemd/system/youeye-ui.service

incus exec $CONTAINER -- bash -c "
  systemctl daemon-reload
  systemctl enable youeye-ui
  systemctl start youeye-ui
  sleep 2
  systemctl status youeye-ui --no-pager
"

echo "=== Step 6: Configure proxy device ==="
# Add proxy device to forward port 3001 on host to 3000 in container
incus config device add $CONTAINER proxy3001 proxy listen=tcp:0.0.0.0:3001 connect=tcp:127.0.0.1:3000 2>/dev/null || true

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
UI_CONTAINER_IP=$(incus list $CONTAINER --format csv -c 4 | head -1 | cut -d' ' -f1)
echo "Container IP: $UI_CONTAINER_IP"
echo "Internal URL: http://$UI_CONTAINER_IP:3000"
echo "External URL: http://192.168.31.190:3001"
echo ""
echo "Test: curl http://$UI_CONTAINER_IP:3000/api/health"
