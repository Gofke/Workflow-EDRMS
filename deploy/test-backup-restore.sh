#!/usr/bin/env bash
# Proves a backup can be restored: backs up the running system, restores it
# into a separate database and storage folder, and compares — row counts,
# every document's SHA-256, and the audit hash chain recomputed on the copy.
#
# Usage: deploy/test-backup-restore.sh [path/to/backend/.env]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$HERE/../backend/.env}"
set -a; # shellcheck disable=SC1090
. "$ENV_FILE"; set +a
export PGPASSWORD="${DB_PASSWORD:-}"
BACKEND_DIR="$(cd "$(dirname "$ENV_FILE")" && pwd)"
case "${DOCUMENT_STORAGE_PATH:-./captured-documents}" in /*) STORAGE="$DOCUMENT_STORAGE_PATH" ;; *) STORAGE="$BACKEND_DIR/${DOCUMENT_STORAGE_PATH:-./captured-documents}" ;; esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" -d postgres -qc "DROP DATABASE IF EXISTS juspol_restore_check;" >/dev/null 2>&1 || true' EXIT
export BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-restore-test-$(date +%s)}"

echo "== 1. Backup (encrypted)"
"$HERE/backup.sh" "$ENV_FILE" "$TMP/backups" > "$TMP/backup.log"
B="$(ls -d "$TMP"/backups/juspol-* | head -1)"
ls -l "$B"

echo "== 2. A damaged backup is refused"
cp -r "$B" "$TMP/damaged"
printf 'x' >> "$TMP/damaged/documents.tar.gz.enc"
if "$HERE/restore.sh" "$TMP/damaged" juspol_restore_check "$TMP/never" >/dev/null 2>&1; then echo "FAIL: damaged backup was restored"; exit 1; else echo "PASS: damaged backup refused"; fi

echo "== 3. Restore into juspol_restore_check"
"$HERE/restore.sh" "$B" juspol_restore_check "$TMP/storage" "$TMP/keys"

echo "== 4. Compare"
q() { psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" -d "$1" -Atc "$2"; }
fail=0
for t in correspondence_item dossier task captured_document audit_event document_seal ai_interaction integrity_anchor; do
  a="$(q "$DB_DATABASE" "SELECT count(*) FROM $t")"; b="$(q juspol_restore_check "SELECT count(*) FROM $t")"
  if [ "$a" = "$b" ]; then echo "PASS rows $t: $a"; else echo "FAIL rows $t: $a vs $b"; fail=1; fi
done
broken="$(q juspol_restore_check "WITH c AS (SELECT seq, chain_hash, audit_event_payload(a) p, lag(chain_hash) OVER (ORDER BY seq) prev FROM audit_event a) SELECT count(*) FROM c WHERE chain_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(prev,'') || '#' || p, 'UTF8')), 'hex')")"
if [ "$broken" = "0" ]; then echo "PASS audit hash chain intact on the restored copy"; else echo "FAIL audit chain broken at $broken event(s)"; fail=1; fi
docs=0; bad=0
while IFS='|' read -r key hash; do
  docs=$((docs+1))
  actual="$(sha256sum "$TMP/storage/$key" 2>/dev/null | cut -d' ' -f1 || true)"
  [ "$actual" = "$hash" ] || bad=$((bad+1))
done < <(q juspol_restore_check "SELECT storage_key, content_hash FROM captured_document UNION SELECT storage_key, content_hash FROM task_attachment")
if [ "$bad" = "0" ]; then echo "PASS all $docs stored files restored byte-for-byte (SHA-256)"; else echo "FAIL $bad of $docs files differ"; fail=1; fi
if [ -f "$TMP/keys/seal-ed25519.pem" ]; then echo "PASS seal key restored"; else echo "FAIL seal key missing"; fail=1; fi
[ "$fail" = "0" ] && echo "RESULT: BACKUP AND RESTORE VERIFIED" || { echo "RESULT: FAILED"; exit 1; }
