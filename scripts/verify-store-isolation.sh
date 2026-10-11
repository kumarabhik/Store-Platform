#!/usr/bin/env bash
# Proves the store NetworkPolicies are enforced (not just present) by opening TCP connections
# from throwaway pods in different namespaces. Expected results are in the table below.
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
probe platform   "$WP" open      # the platform (gateway / provisioner) can reach WordPress
probe platform   "$DB" blocked   # ...but never the database
probe "$NS"      "$WP" open      # pods in the store namespace (its MCP server) reach WordPress
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

kubectl delete namespace np-other --wait=false >/dev/null
[ "$failures" -eq 0 ] && echo "All isolation checks passed." || { echo "$failures isolation check(s) failed."; exit 1; }
