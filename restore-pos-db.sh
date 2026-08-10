#!/bin/bash
# Restore production database to test instance
# Usage:
#   ./restore-pos-db.sh dump <dump-file>           # Restore from weekly dump
#   ./restore-pos-db.sh latest                     # Restore from latest dump
#   ./restore-pos-db.sh pitr "2026-08-09 14:30:00" # PITR (advanced)

set -e

BACKUP_ROOT="/volume1/docker-data/backups/hisweetie-pos"
TEST_DB="hisweetie_restore_test"
MODE="$1"
ARG="$2"

echo "=== Postgres Restore Tool ==="

case "$MODE" in
  dump)
    DUMP_FILE="$ARG"
    if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
      echo "Error: Dump file not found: $DUMP_FILE"
      echo "Usage: $0 dump <path-to-dump-file>"
      exit 1
    fi
    
    echo "Mode: Restore from dump"
    echo "File: $DUMP_FILE"
    echo ""
    
    echo "Dropping test database if exists..."
    /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d postgres -c "DROP DATABASE IF EXISTS $TEST_DB;"
    
    echo "Creating test database..."
    /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d postgres -c "CREATE DATABASE $TEST_DB;"
    
    echo "Restoring from dump..."
    /usr/local/bin/docker exec -i website-pos-hisweetie pg_restore -U root -d "$TEST_DB" -v < "$DUMP_FILE"
    
    echo ""
    echo "✓ Restore completed to database: $TEST_DB"
    echo ""
    echo "Verify with:"
    echo "  /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d $TEST_DB -c '\\dt'"
    echo ""
    echo "Compare table counts:"
    echo "  /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d hisweetie_ban_hang_database -t -c 'SELECT COUNT(*) FROM orders;'"
    echo "  /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d $TEST_DB -t -c 'SELECT COUNT(*) FROM orders;'"
    echo ""
    echo "Cleanup when done:"
    echo "  /usr/local/bin/docker exec website-pos-hisweetie psql -U root -d postgres -c 'DROP DATABASE $TEST_DB;'"
    ;;
    
  latest)
    LATEST_DUMP=$(ls -t "$BACKUP_ROOT/dump"/production-*.dump 2>/dev/null | head -1)
    if [ -z "$LATEST_DUMP" ]; then
      echo "Error: No dump files found in $BACKUP_ROOT/dump/"
      exit 1
    fi
    
    echo "Latest dump: $LATEST_DUMP"
    echo ""
    exec "$0" dump "$LATEST_DUMP"
    ;;
    
  pitr)
    TARGET_TIME="$ARG"
    if [ -z "$TARGET_TIME" ]; then
      echo "Error: Target time required"
      echo "Usage: $0 pitr \"YYYY-MM-DD HH:MM:SS\""
      exit 1
    fi
    
    echo "Mode: Point-in-Time Recovery (PITR)"
    echo "Target: $TARGET_TIME"
    echo ""
    echo "⚠️  PITR is an advanced operation. Steps:"
    echo ""
    echo "1. Find base backup before target time:"
    echo "   ls -lh $BACKUP_ROOT/base/"
    echo ""
    echo "2. Extract base backup to temp directory (outside Docker)"
    echo "3. Create recovery.signal file"
    echo "4. Configure postgresql.conf:"
    echo "   restore_command = 'cp $BACKUP_ROOT/wal/%f %p'"
    echo "   recovery_target_time = '$TARGET_TIME'"
    echo "5. Start temp Postgres instance, let it replay WAL"
    echo "6. When recovery completes, export to dump and restore normally"
    echo ""
    echo "Full docs: https://www.postgresql.org/docs/15/continuous-archiving.html"
    echo ""
    echo "For typical recovery needs, use 'latest' or 'dump' mode instead."
    ;;
    
  *)
    echo "Usage:"
    echo "  $0 dump <dump-file>           # Restore specific dump file"
    echo "  $0 latest                     # Restore latest weekly dump"
    echo "  $0 pitr \"YYYY-MM-DD HH:MM:SS\" # Point-in-Time Recovery (advanced)"
    echo ""
    echo "Examples:"
    echo "  $0 latest"
    echo "  $0 dump $BACKUP_ROOT/dump/production-20260809-030000.dump"
    echo "  $0 pitr \"2026-08-09 14:30:00\""
    exit 1
    ;;
esac