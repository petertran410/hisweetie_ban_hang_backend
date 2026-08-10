#!/bin/bash
set -e

BACKUP_ROOT="/volume1/docker-data/backups/hisweetie-pos"

echo "=== Creating backup directory structure ==="
mkdir -p "$BACKUP_ROOT"/{wal,base,dump}

echo "=== Setting permissions for Postgres (uid 999) ==="
# wal/ and base/ need to be writable by postgres process (uid 999)
if echo Dieptra123 | sudo -S chown -R 999:999 "$BACKUP_ROOT/wal" "$BACKUP_ROOT/base" 2>/dev/null; then
    echo "✓ chown 999:999 successful"
else
    echo "⚠ sudo chown failed, using chmod 777 fallback"
    chmod -R 777 "$BACKUP_ROOT/wal" "$BACKUP_ROOT/base"
fi

# dump/ can stay as tamaki (backup script runs as root inside container)
chmod 755 "$BACKUP_ROOT/dump"

# Create log file
touch "$BACKUP_ROOT/backup.log"
chmod 666 "$BACKUP_ROOT/backup.log"

echo "=== Backup structure ready ==="
echo "Structure:"
ls -la "$BACKUP_ROOT"
echo ""
echo "Permissions:"
ls -ld "$BACKUP_ROOT"/{wal,base,dump}
echo ""
echo "✓ Setup complete. Safe to proceed with docker-compose changes."