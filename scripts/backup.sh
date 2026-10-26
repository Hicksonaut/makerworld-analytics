#!/bin/bash
# Taegliches Backup der MakerWorld-Analytics-Datenbank (+ Projekt-Dateien).
# - sqlite3 ".backup" ist die Online-Backup-API: konsistent, auch waehrend der Dienst laeuft.
# - Laeuft mit niedrigster CPU-/I/O-Prioritaet (die Pi hat wenig RAM und teilt sich die SD-Karte mit anderen Diensten).
# - Prueft jedes Backup (quick_check) und rotiert nach KEEP_DAYS Tagen.
set -euo pipefail
APP_DIR="${APP_DIR:-$HOME/makerworld-analytics-app}"
DEST="${BACKUP_DIR:-$HOME/backups/makerworld}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB="$APP_DIR/data/makerworld.db"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p "$DEST"
[ -f "$DB" ] || { echo "DB nicht gefunden: $DB" >&2; exit 1; }

TMP="$DEST/.tmp-$STAMP.db"
trap 'rm -f "$TMP" "$TMP-wal" "$TMP-shm"' EXIT
nice -n 19 ionice -c3 sqlite3 "$DB" ".backup '$TMP'"
CHECK="$(sqlite3 "$TMP" 'PRAGMA quick_check;')"
[ "$CHECK" = "ok" ] || { echo "quick_check fehlgeschlagen: $CHECK" >&2; exit 1; }
nice -n 19 ionice -c3 gzip -c "$TMP" > "$DEST/makerworld-$STAMP.db.gz"

# Projekt-Dateien (.3mf von Kunden) lassen sich nicht neu abrufen -> mitsichern, falls vorhanden.
if [ -d "$APP_DIR/data/project_files" ] && [ -n "$(ls -A "$APP_DIR/data/project_files" 2>/dev/null)" ]; then
  tar -czf "$DEST/project_files-$STAMP.tar.gz" -C "$APP_DIR/data" project_files
fi

find "$DEST" -maxdepth 1 \( -name 'makerworld-*.db.gz' -o -name 'project_files-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
SIZE="$(du -h "$DEST/makerworld-$STAMP.db.gz" | cut -f1)"
echo "$(date -Iseconds) ok makerworld-$STAMP.db.gz ($SIZE)" | tee "$DEST/last-backup.txt"
