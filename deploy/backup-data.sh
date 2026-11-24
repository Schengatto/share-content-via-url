#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/root/share-secret/data}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-7}"
ARCHIVE_PREFIX="share-secret-data-"

usage() {
  echo "usage: $0 <label> | --prune" >&2
  exit 2
}

prune_expired_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${ARCHIVE_PREFIX}*.tgz" \
    -mmin +$((MAX_AGE_DAYS * 1440)) -print -delete
}

create_backup() {
  local label="$1"
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || usage
  [[ -f "$DATA_DIR/share.db" ]] || { echo "no share.db in $DATA_DIR" >&2; exit 1; }

  umask 077
  mkdir -p "$BACKUP_DIR"
  local data_parent data_name archive_name archive
  data_parent="$(dirname "$DATA_DIR")"
  data_name="$(basename "$DATA_DIR")"
  archive_name="${ARCHIVE_PREFIX}${label}-$(date -u +%Y%m%dT%H%M%SZ).tgz"
  archive="$BACKUP_DIR/$archive_name"
  partial_archive="$archive.partial"
  trap 'rm -f "$partial_archive"' EXIT

  tar -czf "$partial_archive" -C "$data_parent" "$data_name"
  tar -tzf "$partial_archive" | grep -qx "$data_name/share.db"
  chmod 600 "$partial_archive"
  mv "$partial_archive" "$archive"

  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${ARCHIVE_PREFIX}*.tgz" \
    ! -name "$archive_name" -print -delete
  echo "$archive"
}

[[ $# -eq 1 ]] || usage
case "$1" in
  --prune) prune_expired_backups ;;
  -*) usage ;;
  *) create_backup "$1" ;;
esac
