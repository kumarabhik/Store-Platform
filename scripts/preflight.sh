#!/usr/bin/env bash
# Pre-recording check (DEMO.md step 0): is everything the demo touches up right now?
# Read-only: it changes nothing. Each line prints PASS, WARN or FAIL; exits non-zero on any FAIL.
#
#   ADMIN_TOKEN=$(cat /tmp/sa) bash scripts/preflight.sh
#
# Options: API (default http://api.127.0.0.1.nip.io:8088), DASHBOARD (default
# http://dashboard.127.0.0.1.nip.io:8088), ADMIN_TOKEN (an admin session; without it the
# upstream check is skipped), BACKUP_MAX_AGE_HOURS (default 26, as the BackupMissing alert).
# Requires: curl, node, kubectl pointed at the cluster.
set -uo pipefail

API="${API:-http://api.127.0.0.1.nip.io:8088}"
DASHBOARD="${DASHBOARD:-http://dashboard.127.0.0.1.nip.io:8088}"
MAX_AGE_H="${BACKUP_MAX_AGE_HOURS:-26}"
CURL=(curl -sS --max-time 15)
failures=0

pass() { echo "PASS  $*"; }
warn() { echo "WARN  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval(process.argv[1]);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch{console.log('')}})" "$1"; }

# 1. The cluster answers, and it is the one we expect.
ctx=$(kubectl config current-context 2>/dev/null)
if kubectl get ns default --request-timeout=10s > /dev/null 2>&1; then pass "cluster reachable (context $ctx)"; else fail "cluster not reachable (context '$ctx'); run ops/resume.ps1"; echo "1 FAIL, stopping"; exit 1; fi

# 2. Every pod in the namespaces the demo uses is Running and Ready (or a finished Job pod).
namespaces="platform mcp-servers backups monitoring ingress-nginx $(kubectl get ns -o name | sed -n 's#^namespace/\(store-.*\)#\1#p' | tr '\n' ' ')"
for ns in $namespaces; do
  bad=$(kubectl -n "$ns" get pods --no-headers 2>/dev/null | awk '$3!="Completed" && ($3!="Running" || split($2,r,"/") && r[1]!=r[2]) {print $1" ("$3", "$2")"}')
  if [ -z "$bad" ]; then pass "pods ready in $ns"; else fail "pods not ready in $ns: $(echo $bad)"; fi
done

# 3. New pods can start. A stale Calico token only breaks NEW pods, so everything above can look
#    fine while the next store or backup can't start (SYSTEM.md L26). Events live ~1 h, so only
#    the last 15 minutes count: older ones may be from a problem that was already fixed.
since=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
sandbox=$(kubectl get events -A --field-selector reason=FailedCreatePodSandBox \
  -o jsonpath='{range .items[*]}{.lastTimestamp}{"\n"}{end}' 2>/dev/null | awk -v s="$since" '$1 >= s' | wc -l)
if [ "$sandbox" -eq 0 ]; then pass "new pods can start (no FailedCreatePodSandBox in 15 min)"
else fail "$sandbox FailedCreatePodSandBox events in 15 min: kubectl -n kube-system rollout restart ds/calico-node (SYSTEM.md L26)"; fi

# 4. API and dashboard answer through the ingress (port-forward 8088, SYSTEM.md L5).
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$API/healthz" 2>/dev/null)
if [ "$code" = 200 ]; then pass "API $API/healthz"; else fail "API $API/healthz answered '$code' (is the 8088 port-forward running? ops/up.ps1)"; fi
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$DASHBOARD/" 2>/dev/null)
if [ "$code" = 200 ]; then pass "dashboard $DASHBOARD"; else fail "dashboard $DASHBOARD answered '$code'"; fi

# 5. Every enabled upstream is Connected (the Servers page the video opens on).
if [ -n "${ADMIN_TOKEN:-}" ]; then
  servers=$("${CURL[@]}" -H "Authorization: Bearer $(echo "$ADMIN_TOKEN" | tr -d '\r\n')" "$API/api/servers")
  total=$(echo "$servers" | json 'j.servers.filter(s=>s.enabled).length')
  down=$(echo "$servers" | json 'j.servers.filter(s=>s.enabled&&s.status!=="Connected").map(s=>s.slug+"="+s.status).join(" ")')
  if [ -z "$total" ]; then fail "could not list servers (is ADMIN_TOKEN an admin session?)"
  elif [ -z "$down" ]; then pass "all $total enabled upstreams Connected"
  else fail "upstreams not Connected: $down"; fi
else
  warn "ADMIN_TOKEN not set: upstream status not checked"
fi

# 6. The chat's LLM key works and the configured model exists. Run inside the API pod, so the key
#    never leaves it; only "ok"/"missing" and the HTTP status come back.
llm=$(kubectl -n platform exec deploy/platform-api -- node -e '
  const key = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
  const base = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  if (!key) { console.log("no-key"); process.exit(0); }
  fetch(base + "/models", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(10000) })
    .then(async (r) => { const j = r.ok ? await r.json() : {}; console.log((j.data || []).some((m) => m.id === model) ? "ok " + model : "missing " + model + " HTTP " + r.status); })
    .catch((e) => console.log("error " + e.message));' 2>&1 | tail -1)
case "$llm" in
  ok*) pass "LLM model available (${llm#ok })" ;;
  no-key) fail "no LLM_API_KEY/GROQ_API_KEY in platform-api: the chat answers 503" ;;
  *) fail "LLM check: $llm" ;;
esac

# 7. Every nightly backup succeeded recently (the same rule as the BackupMissing alert).
now=$(date -u +%s)
while read -r name last; do
  [ -z "$name" ] && continue
  if [ -z "$last" ]; then fail "backup $name has never succeeded"; continue; fi
  age_h=$(( (now - $(date -u -d "$last" +%s)) / 3600 ))
  if [ "$age_h" -le "$MAX_AGE_H" ]; then pass "backup $name last succeeded ${age_h} h ago"
  else fail "backup $name last succeeded ${age_h} h ago (> $MAX_AGE_H h)"; fi
done < <(kubectl get cronjob -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.status.lastSuccessfulTime}{"\n"}{end}' | grep -- '-backup ')

# 8. No alert firing except Watchdog (which always fires, to prove the alert pipeline works).
alerts=$(kubectl -n monitoring exec prometheus-kps-prometheus-0 -c prometheus -- wget -qO- http://localhost:9090/api/v1/alerts 2>/dev/null)
if [ -z "$alerts" ]; then
  warn "Prometheus not reachable: alerts not checked"
else
  firing=$(echo "$alerts" | json 'j.data.alerts.filter(a=>a.state==="firing"&&a.labels.alertname!=="Watchdog").map(a=>a.labels.alertname+(a.labels.server?"("+a.labels.server+")":a.labels.namespace?"("+a.labels.namespace+")":"")).join(" ")')
  if [ -z "$firing" ]; then pass "no alerts firing (besides Watchdog)"; else warn "alerts firing: $firing"; fi
fi

echo
if [ "$failures" -eq 0 ]; then echo "Preflight: ready to record."; else echo "Preflight: $failures FAIL(s); fix them before recording."; fi
exit $((failures > 0))
