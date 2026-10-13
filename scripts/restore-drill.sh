#!/usr/bin/env bash
# Restore drill (DESIGN §13.6): proves a store backup can actually be restored.
#   1. take a fresh backup of the store (its nightly CronJob, run now)
#   2. download stores/<release>/latest.sql.gz from the backup store
#   3. load it into a throwaway MariaDB in namespace restore-drill
#   4. compare order and product counts with the live store, then delete the scratch namespace
# Usage: bash scripts/restore-drill.sh [release] [namespace]   (default: store-default store-default)
set -uo pipefail

REL="${1:-store-default}"
NS="${2:-$REL}"
DRILL=restore-drill
MARIADB_IMAGE=mariadb:11.4.13
CURL_IMAGE=curlimages/curl:8.11.1
failures=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }
cleanup() { kubectl delete namespace "$DRILL" --wait=false --ignore-not-found >/dev/null 2>&1; rm -f "${DUMP:-}"; }
trap cleanup EXIT

# This store keeps orders in wp_posts (WooCommerce's legacy order storage; HPOS tables aren't used).
sql_count='select (select count(*) from wp_posts where post_type="shop_order"), (select count(*) from wp_posts where post_type="product" and post_status="publish")'

# 1. Fresh backup, so the live store and the dump describe the same moment.
job="restore-drill-$(date +%s)"
kubectl -n "$NS" create job "$job" --from="cronjob/$REL-backup" >/dev/null
kubectl -n "$NS" wait --for=condition=complete "job/$job" --timeout=300s >/dev/null && pass "fresh backup uploaded ($job)" || { fail "backup job $job"; exit 1; }
kubectl -n "$NS" delete job "$job" --wait=false >/dev/null
live=$(kubectl -n "$NS" exec "statefulset/$REL-mariadb" -- sh -c "mariadb -N -uroot -p\"\$MARIADB_ROOT_PASSWORD\" wordpress -e '$sql_count'" | tr '\t' ' ')

# 2. Download through a pod the backup store admits (label store-platform/backup-client).
kubectl create namespace "$DRILL" >/dev/null
b() { kubectl -n backups get secret backups-credentials -o "jsonpath={.data.$1}" | base64 -d; }
DUMP=$(mktemp)
kubectl -n "$DRILL" run fetch --rm -i --restart=Never --quiet --image="$CURL_IMAGE" \
  --labels=store-platform/backup-client=true -- sh -c \
  "curl -fsS --aws-sigv4 'aws:amz:garage:s3' --user '$(b access-key-id):$(b secret-access-key)' \
   http://garage.backups.svc.cluster.local:3900/backups/stores/$REL/latest.sql.gz | base64" 2>/dev/null | base64 -d > "$DUMP"
size=$(wc -c < "$DUMP")
[ "$size" -gt 1000 ] && pass "downloaded stores/$REL/latest.sql.gz ($size bytes)" || { fail "download ($size bytes)"; exit 1; }

# 3. Throwaway MariaDB, then load the dump.
kubectl -n "$DRILL" run db --image="$MARIADB_IMAGE" --env=MARIADB_ROOT_PASSWORD=drill --env=MARIADB_DATABASE=wordpress \
  --labels=app=restore-drill-db >/dev/null
kubectl -n "$DRILL" wait --for=condition=Ready pod/db --timeout=180s >/dev/null
# First boot initializes the data directory and can take minutes (SYSTEM.md L3).
for _ in $(seq 1 90); do kubectl -n "$DRILL" exec db -- mariadb -uroot -pdrill -e "select 1" >/dev/null 2>&1 && break; sleep 2; done
gunzip -c "$DUMP" | kubectl -n "$DRILL" exec -i db -- mariadb -uroot -pdrill wordpress && pass "dump loaded into a scratch database" || fail "loading the dump"
restored=$(kubectl -n "$DRILL" exec db -- mariadb -N -uroot -pdrill wordpress -e "$sql_count" | tr '\t' ' ')

# 4. Compare.
echo "      live store:  orders products = $live"
echo "      restored:    orders products = $restored"
[ -n "$restored" ] && [ "$restored" = "$live" ] && pass "restored counts match the live store" || fail "counts differ"

echo
[ "$failures" -eq 0 ] && echo "Restore drill passed." || { echo "Restore drill: $failures check(s) failed."; exit 1; }
