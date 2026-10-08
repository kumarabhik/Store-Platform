#!/usr/bin/env bash
# Proves the store NetworkPolicies are enforced (not just present) by opening TCP connections
# from throwaway pods in different namespaces. Expected results are in the table below.
set -uo pipefail

NS="${NS:-store-default}"
REL="${REL:-store-default}"
DB="${REL}-mariadb.${NS}.svc.cluster.local:3306"
WP="${REL}-wordpress.${NS}.svc.cluster.local:80"
failures=0

probe() {  # probe <from-namespace> <target host:port> <expect: open|blocked>
  local from=$1 target=$2 expect=$3 got
  if kubectl -n "$from" run "np-probe-$RANDOM" --rm -i --restart=Never --quiet \
      --image=busybox:1.36 --labels=app=np-probe -- nc -z -w 3 "${target%:*}" "${target##*:}" >/dev/null 2>&1; then
    got=open
  else
    got=blocked
  fi
  if [ "$got" = "$expect" ]; then
    printf 'PASS  %-14s -> %-58s %s\n' "$from" "$target" "$got"
  else
    printf 'FAIL  %-14s -> %-58s %s (expected %s)\n' "$from" "$target" "$got" "$expect"
    failures=$((failures + 1))
  fi
}

kubectl create namespace np-other --dry-run=client -o yaml | kubectl apply -f - >/dev/null

probe np-other   "$WP" blocked   # another tenant cannot reach this store's WordPress
probe np-other   "$DB" blocked   # ...or its database
probe platform   "$WP" open      # the platform (gateway / provisioner) can reach WordPress
probe platform   "$DB" blocked   # ...but never the database
probe "$NS"      "$WP" open      # pods in the store namespace (its MCP server) reach WordPress
probe "$NS"      "$DB" blocked   # ...but only WordPress and the init job may reach the database

kubectl delete namespace np-other --wait=false >/dev/null
[ "$failures" -eq 0 ] && echo "All isolation checks passed." || { echo "$failures isolation check(s) failed."; exit 1; }
