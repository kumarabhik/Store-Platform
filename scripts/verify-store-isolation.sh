#!/usr/bin/env bash
# Proves the NetworkPolicies are enforced (not just present) by opening TCP connections from
# throwaway pods in different namespaces and from the real workloads (egress). Expected results
# are in the lines below.
set -uo pipefail

NS="${NS:-store-default}"
REL="${REL:-store-default}"
DB="${REL}-mariadb.${NS}.svc.cluster.local:3306"
WP="${REL}-wordpress.${NS}.svc.cluster.local:80"
MCP="${REL}-woo-mcp.${NS}.svc.cluster.local:80"
failures=0

report() {  # report <from> <target> <got> <expect>
  local from=$1 target=$2 got=$3 expect=$4
  if [ "$got" = "$expect" ]; then
    printf 'PASS  %-14s -> %-58s %s\n' "$from" "$target" "$got"
  else
    printf 'FAIL  %-14s -> %-58s %s (expected %s)\n' "$from" "$target" "$got" "$expect"
    failures=$((failures + 1))
  fi
}

probe() {  # probe <from-namespace> <target host:port> <expect: open|blocked>  (throwaway busybox pod)
  local from=$1 target=$2 expect=$3 got=blocked
  kubectl -n "$from" run "np-probe-$RANDOM" --rm -i --restart=Never --quiet \
    --image=busybox:1.36 --labels=app=np-probe -- nc -z -w 3 "${target%:*}" "${target##*:}" >/dev/null 2>&1 && got=open
  report "$from" "$target" "$got" "$expect"
}

# From inside an existing workload (egress checks). Uses nc, or bash /dev/tcp where the image
# has no nc (WordPress).
probe_from() {  # probe_from <namespace> <workload> <host:port> <expect>
  local ns=$1 wl=$2 target=$3 expect=$4 got=blocked host=${3%:*} port=${3##*:}
  kubectl -n "$ns" exec "$wl" -- sh -c     "if command -v nc >/dev/null; then nc -z -w 3 $host $port; else timeout 3 bash -c '</dev/tcp/$host/$port'; fi"     >/dev/null 2>&1 && got=open
  report "${wl#*/}" "$target" "$got" "$expect"
}

# From the real platform-api pod. A throwaway pod with its labels would also join the
# platform-api Service and receive live API traffic, so exec into the existing pod instead.
probe_gateway() {  # probe_gateway <target host:port> <expect>
  local target=$1 expect=$2 got=blocked
  kubectl -n platform exec deploy/platform-api -- nc -z -w 3 "${target%:*}" "${target##*:}" >/dev/null 2>&1 && got=open
  report "platform-api" "$target" "$got" "$expect"
}

kubectl create namespace np-other --dry-run=client -o yaml | kubectl apply -f - >/dev/null

probe np-other   "$WP" blocked   # another tenant cannot reach this store's WordPress
probe np-other   "$DB" blocked   # ...or its database
probe platform   "$WP" blocked   # platform is default-deny: a random pod there gets nowhere...
probe_gateway    "$WP" open      # ...only platform-api (provisioner readiness checks) reaches WordPress
probe platform   "$DB" blocked   # ...and nothing in platform reaches the database
# A random pod in the store's namespace: store-default only denies its release's pods, while a
# provisioned store's namespace is default-deny as a whole (provisioner), so there it is blocked.
ns_wide_deny=$(kubectl -n "$NS" get networkpolicy default-deny -o name 2>/dev/null)
probe "$NS"      "$WP" "$([ -n "$ns_wide_deny" ] && echo blocked || echo open)"
probe "$NS"      "$DB" blocked   # ...but only WordPress and the init job may reach the database

# woo-mcp: only the gateway may call it (DESIGN §4.2).
probe np-other   "$MCP" blocked  # not another tenant
probe "$NS"      "$MCP" blocked  # not other pods in its own namespace
probe platform   "$MCP" blocked  # not any pod in platform, only platform-api
probe_gateway    "$MCP" open     # the gateway can
# Not exposed outside the cluster: ClusterIP and no Ingress routes to it.
svc_type=$(kubectl -n "$NS" get svc "${REL}-woo-mcp" -o jsonpath='{.spec.type}')
report "outside" "${REL}-woo-mcp Service type" "$svc_type" ClusterIP
ingress_hits=$(kubectl get ingress -A -o jsonpath='{range .items[*]}{..service.name}{"\n"}{end}' | grep -c -- "-woo-mcp" || true)
report "outside" "Ingress backends naming *-woo-mcp" "$ingress_hits" 0

# Upstream MCP servers in mcp-servers (charts/mcp-upstreams): same rule, only the gateway.
NOTES="notes-mcp.mcp-servers.svc.cluster.local:80"
EVERYTHING="everything-mcp.mcp-servers.svc.cluster.local:80"
probe np-other     "$NOTES" blocked
probe mcp-servers  "$NOTES" blocked       # not even its neighbour in the same namespace
probe platform     "$EVERYTHING" blocked
probe_gateway      "$NOTES" open
probe_gateway      "$EVERYTHING" open

# Egress (default deny, DESIGN §8.5). Targets are IPs, so "blocked" is the policy and not just
# the missing DNS rule (SYSTEM.md L21). 1.1.1.1:443 stands for "the public internet".
svc_ip() { kubectl -n "$1" get svc "$2" -o jsonpath='{.spec.clusterIP}'; }
PUBLIC="1.1.1.1:443"
WP_IP="$(svc_ip "$NS" "${REL}-wordpress"):80"
DB_IP="$(svc_ip "$NS" "${REL}-mariadb"):3306"
MCP_IP="$(svc_ip "$NS" "${REL}-woo-mcp"):80"
API_IP="$(svc_ip platform platform-api):80"
NOTES_IP="$(svc_ip mcp-servers notes-mcp):80"

probe np-other "platform-api.platform.svc.cluster.local:9464" blocked   # metrics port: monitoring ns only
probe_gateway  "$PUBLIC" open                          # LLM provider over HTTPS
probe_gateway  "kubernetes.default.svc.cluster.local:443" open   # reconciler -> K8s API
probe_gateway  "169.254.169.254:80" blocked             # cloud metadata (SSRF target)
probe_from platform deploy/platform-dashboard "$API_IP" open     # dashboard /api proxy
probe_from platform deploy/platform-dashboard "$PUBLIC" blocked
probe_from platform deploy/platform-dashboard "$WP_IP" blocked
probe_from "$NS" "deploy/${REL}-woo-mcp" "$WP_IP" open       # its only job
probe_from "$NS" "deploy/${REL}-woo-mcp" "$DB_IP" blocked    # never the database directly
probe_from "$NS" "deploy/${REL}-woo-mcp" "$PUBLIC" blocked
probe_from "$NS" "deploy/${REL}-woo-mcp" "$NOTES_IP" blocked
probe_from "$NS" "deploy/${REL}-wordpress" "$DB_IP" open     # its database
probe_from "$NS" "deploy/${REL}-wordpress" "$PUBLIC" open    # plugin downloads, updates
probe_from "$NS" "deploy/${REL}-wordpress" "$MCP_IP" blocked
probe_from "$NS" "deploy/${REL}-wordpress" "$API_IP" blocked
probe_from mcp-servers deploy/notes-mcp "$PUBLIC" blocked     # upstreams can't call out at all
probe_from mcp-servers deploy/notes-mcp "$WP_IP" blocked
probe_from mcp-servers deploy/notes-mcp "$API_IP" blocked
probe_from mcp-servers deploy/everything-mcp "$PUBLIC" blocked

# Between provisioned stores (bonus, DESIGN §11): set OTHER_ID to a second store's id. Store A's
# pods must not reach store B at all, and B's own MCP server is still reachable by the gateway.
if [ -n "${OTHER_ID:-}" ]; then
  ONS="store-${OTHER_ID}" OREL="wc-${OTHER_ID}"
  O_WP="$(svc_ip "$ONS" "${OREL}-wordpress"):80"
  O_DB="$(svc_ip "$ONS" "${OREL}-mariadb"):3306"
  O_MCP="$(svc_ip "$ONS" "${OREL}-woo-mcp"):80"
  probe_from "$NS" "deploy/${REL}-woo-mcp" "$O_WP" blocked     # A's MCP server -> B's store
  probe_from "$NS" "deploy/${REL}-wordpress" "$O_WP" blocked   # A's WordPress -> B's WordPress
  probe_from "$NS" "deploy/${REL}-wordpress" "$O_DB" blocked   # A's WordPress -> B's database
  probe_from "$NS" "deploy/${REL}-wordpress" "$O_MCP" blocked  # A's WordPress -> B's MCP server
  probe_from "$ONS" "deploy/${OREL}-woo-mcp" "$WP_IP" blocked  # and the other way round
  probe "$ONS" "$DB" blocked                                   # a throwaway pod in B -> A's database
  probe_gateway "${OREL}-woo-mcp.${ONS}.svc.cluster.local:80" open   # gateway -> B's MCP server
fi

kubectl delete namespace np-other --wait=false --ignore-not-found >/dev/null
[ "$failures" -eq 0 ] && echo "All isolation checks passed." || { echo "$failures isolation check(s) failed."; exit 1; }
