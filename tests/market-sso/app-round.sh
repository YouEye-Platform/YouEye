#!/usr/bin/env bash
# app-round.sh <app> [keep]: on the test box, install one Market app with the CLI, check it, restart it, check again,
# then uninstall with delete-data and check that nothing is left. With "keep": install + checks, then stop it.
# Prints one RESULT line: RESULT <app> PASS|FAIL <notes>.
set -uo pipefail
app=$1; keep=${2:-}
# BOX_SSH is the box's root SSH command, e.g. BOX_SSH="ssh -i ~/.ssh/key -o BatchMode=yes root@192.168.1.50".
: "${BOX_SSH:?set BOX_SSH to the root ssh command of the test box}"
box() { timeout "${T:-900}" $BOX_SSH -o ServerAliveInterval=30 "$@"; }
notes=(); fail=0
note() { notes+=("$*"); }
bad() { notes+=("$*"); fail=1; }

out=$(T=1500 box "timeout 1400 youeye app install $app 2>&1" ); rc=$?
echo "$out" | tail -4 | sed "s/^/  [$app install] /"
echo "$out" | grep -q "installed successfully" || { bad "install failed rc=$rc: $(echo "$out" | grep -iE 'error|fail' | tail -1 | cut -c1-160)"; }

check() {  # containers running + tagged, app dir modes
  box "set -e
    cs=\$(incus list -c n -f csv | grep -E '^app-${app}(-|\$)' || true)
    [ -n \"\$cs\" ] || { echo 'NOCONTAINERS'; exit 0; }
    for c in \$cs; do
      st=\$(incus list \$c -c s -f csv); tag=\$(incus config get \$c user.youeye.installation_id)
      echo \"CT \$c \$st \${tag:-NOTAG}\"
    done
    stat -c 'DIR %a %n' /var/lib/youeye/app-${app} /var/lib/youeye/app-${app}/secrets 2>/dev/null || true
    find /var/lib/youeye/app-${app}/secrets -type f -printf 'SECRET %m %f\n' 2>/dev/null | head -5
    youeye app list 2>/dev/null | grep -E '^ *${app} ' || true" 2>&1
}
if [ $fail = 0 ]; then
  c1=$(check); echo "$c1" | sed "s/^/  [$app check] /"
  echo "$c1" | grep -q "^CT .* RUNNING [0-9a-f-]\{36\}" || bad "containers not running+tagged"
  echo "$c1" | grep -q "NOTAG\|STOPPED\|ERROR" && bad "a container is untagged or not running"
  echo "$c1" | grep -E "^DIR " | grep -vq "^DIR 700 " && bad "app dir not 0700"
  echo "$c1" | grep -E "^SECRET " | grep -vq "^SECRET 600 " && bad "secret not 0600"
  # restart: still running and healthy afterwards
  r=$(box "timeout 600 youeye app restart $app 2>&1 | tail -2; sleep 20; youeye app list 2>/dev/null | grep -E '^ *${app} '" 2>&1)
  echo "$r" | sed "s/^/  [$app restart] /"
  echo "$r" | grep -qE "running" || bad "not running after restart"
fi

if [ "$keep" = keep ]; then
  [ $fail = 0 ] && box "timeout 300 youeye app stop $app >/dev/null 2>&1" && note "installed and stopped (kept)"
else
  u=$(box "echo y | timeout 900 youeye app remove $app 2>&1 | tail -2
    echo '--- leftovers'
    incus list -c n -f csv | grep -E '^app-${app}(-|\$)' | sed 's/^/LEFT ct /'
    incus storage volume list default -f csv 2>/dev/null | grep -E 'ye-${app}-|app-${app}' | sed 's/^/LEFT vol /'
    incus network list -f csv | grep -iE '(^|[^a-z0-9-])${app}([^a-z0-9-]|\$)' | sed 's/^/LEFT net /'
    for d in /var/lib/youeye/app-${app} /var/lib/youeye/apps/${app}; do [ -e \$d ] && echo LEFT dir \$d; done
    incus exec youeye-caddy -- wget -qO- localhost:2019/config/ 2>/dev/null | grep -o '\"${app}\\.[a-z0-9.-]*' | sort -u | sed 's/^/LEFT route /'
    incus exec youeye-postgres -- psql -U youeye -d youeye -Atc \"select 'LEFT db '||datname from pg_database where datname in ('${app//-/_}','ye_${app//-/_}') union all select 'LEFT role '||rolname from pg_roles where rolname in ('${app//-/_}','ye_${app//-/_}')\" 2>/dev/null
    true" 2>&1)
  echo "$u" | sed "s/^/  [$app remove] /"
  echo "$u" | grep -q "removed" || bad "remove did not report success"
  echo "$u" | grep -q "^LEFT" && bad "leftovers: $(echo "$u" | grep '^LEFT' | tr '\n' ';')"
fi
[ $fail = 0 ] && echo "RESULT $app PASS ${notes[*]:-}" || echo "RESULT $app FAIL ${notes[*]}"
