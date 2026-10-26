#!/bin/bash
# Holt die Backups von der Pi auf den Mac/die SSD (Kopie ausserhalb der SD-Karte).
# Aufruf: scripts/pull-backups-to-mac.sh [Zielordner]
set -euo pipefail
PI="${PI:-youruser@raspberrypi.local}"
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/_backups}"
mkdir -p "$DEST"
rsync -av --ignore-existing "$PI:backups/makerworld/" "$DEST/"
echo "Backups in $DEST: $(ls "$DEST" | wc -l | tr -d ' ') Dateien"
