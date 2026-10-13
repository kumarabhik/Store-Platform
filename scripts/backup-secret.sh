#!/usr/bin/env bash
# Copies the backup store's upload key into the given namespaces as Secret "backup-s3", the Secret
# the nightly backup CronJobs read (DESIGN §13.6). A Secret can only be read in its own namespace,
# so every namespace with a backup job gets its own copy. Safe to rerun (apply = create or update).
#   bash scripts/backup-secret.sh platform store-default
set -euo pipefail

SRC_NS="${BACKUP_NS:-backups}"
SRC="${BACKUP_SECRET:-backups-credentials}"
get() { kubectl -n "$SRC_NS" get secret "$SRC" -o "jsonpath={.data.$1}" | base64 -d; }

key_id=$(get access-key-id)
secret=$(get secret-access-key)
[ -n "$key_id" ] && [ -n "$secret" ] || { echo "backup-secret: $SRC_NS/$SRC has no upload key (is charts/backups installed?)" >&2; exit 1; }

for ns in "$@"; do
  kubectl -n "$ns" create secret generic backup-s3 \
    --from-literal=endpoint="http://garage.$SRC_NS.svc.cluster.local:3900" \
    --from-literal=bucket=backups \
    --from-literal=region=garage \
    --from-literal=access-key-id="$key_id" \
    --from-literal=secret-access-key="$secret" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "backup-s3 ready in $ns"
done
