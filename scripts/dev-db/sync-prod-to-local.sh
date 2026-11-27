#!/bin/bash
# Sao chép DB production về Postgres local (container Docker) cho môi trường dev.
# Chạy tay khi cần làm mới: bash scripts/dev-db/sync-prod-to-local.sh
#
# - Chỉ ĐỌC production (pg_dump). Không ghi gì lên production.
# - Khôi phục vào DB tạm rồi mới đổi tên → lỗi giữa chừng thì DB local cũ vẫn dùng được.
# - Sau khi khôi phục: tắt các thứ gửi ra ngoài (webhook Public API, cron đẩy sản phẩm lên Lark)
#   để backend dev không gửi trùng việc production đã làm.
#
# Cấu hình (không nằm trong repo, chmod 600): ~/.config/pos-dev-db/env
#   PROD_DATABASE_URL=postgresql://user:pass@host:port/db   (chuỗi Prisma cũng được, tự bỏ ?query)
#   LOCAL_DB_PASSWORD=...
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

CONFIG="$HOME/.config/pos-dev-db/env"
DATA_DIR="$HOME/.local/share/pos-dev-db"
DUMP_DIR="$DATA_DIR/dumps"
CONTAINER=pos-dev-db
IMAGE=postgres:15-alpine # cùng major với production (15.x): pg_dump/pg_restore khớp phiên bản
PORT=5455
DB=hisweetie_ban_hang_dev
KEEP_DUMPS=2

log() { echo "[$(date '+%F %T')] $*"; }

# shellcheck source=/dev/null
source "$CONFIG"
: "${PROD_DATABASE_URL:?thiếu PROD_DATABASE_URL trong $CONFIG}"
: "${LOCAL_DB_PASSWORD:?thiếu LOCAL_DB_PASSWORD trong $CONFIG}"
# Tách URL thành biến PG* cho pg_dump: mật khẩu có thể chứa "@" không mã hoá (Prisma chấp nhận, libpq
# thì không) → user:pass là phần trước "@" CUỐI; bỏ ?query của Prisma (connection_limit…)
url="${PROD_DATABASE_URL%%\?*}"
url="${url#*://}"
userinfo="${url%@*}"
hostpart="${url##*@}"
hostport="${hostpart%%/*}"
urldecode() { printf '%b' "${1//%/\\x}"; }
export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
PGUSER="$(urldecode "${userinfo%%:*}")"
PGPASSWORD="$(urldecode "${userinfo#*:}")"
PGHOST="${hostport%:*}"
PGPORT="${hostport##*:}"
[ "$PGPORT" = "$hostport" ] && PGPORT=5432
PGDATABASE="${hostpart#*/}"

mkdir -p "$DUMP_DIR"
LOCK="$DATA_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "Đang có lượt sao chép khác chạy ($LOCK) → bỏ qua"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT
rm -f "$DUMP_DIR"/*.part # dump dở của lượt lỗi trước

# Docker (Colima) chưa chạy, vd máy vừa khởi động → bật lên
if ! docker info >/dev/null 2>&1; then
  log "Docker chưa chạy → colima start"
  colima start
fi

if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  log "Tạo container $CONTAINER (127.0.0.1:$PORT)"
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -e POSTGRES_PASSWORD="$LOCAL_DB_PASSWORD" \
    -p "127.0.0.1:$PORT:5432" \
    -v pos-dev-db_pgdata:/var/lib/postgresql/data \
    -v "$DUMP_DIR:/dumps:ro" \
    "$IMAGE" >/dev/null
fi
docker start "$CONTAINER" >/dev/null
until docker exec "$CONTAINER" pg_isready -U postgres -q; do sleep 1; done

psql_local() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

DUMP="$(date '+%Y%m%d-%H%M').dump"
log "pg_dump production → $DUMP_DIR/$DUMP"
started=$(date +%s)
# -e TÊN (không kèm giá trị): mật khẩu không nằm trên dòng lệnh
docker run --rm -e PGUSER -e PGPASSWORD -e PGHOST -e PGPORT -e PGDATABASE "$IMAGE" \
  pg_dump --format=custom --no-owner --no-acl \
  >"$DUMP_DIR/$DUMP.part"
mv "$DUMP_DIR/$DUMP.part" "$DUMP_DIR/$DUMP"
log "Dump xong: $(du -h "$DUMP_DIR/$DUMP" | cut -f1), $(($(date +%s) - started))s"

log "Khôi phục vào ${DB}_new"
psql_local -d postgres -c "DROP DATABASE IF EXISTS ${DB}_new WITH (FORCE)" -c "CREATE DATABASE ${DB}_new"
docker exec "$CONTAINER" pg_restore -U postgres -d "${DB}_new" --no-owner --no-acl --jobs=4 --exit-on-error "/dumps/$DUMP"

log "Tắt gửi ra ngoài trên bản sao"
psql_local -d "${DB}_new" <<'SQL'
-- Webhook Public API: con trỏ trong bản sao chậm hơn production → gửi lại sự kiện đối tác đã nhận
UPDATE public_api_webhooks SET is_active = false WHERE is_active;
-- Cron đẩy lại sản phẩm lên Lark Base: dữ liệu bản sao cũ hơn production → có thể ghi đè dữ liệu mới
UPDATE settings SET lark_product_retry_cron_enabled = false;
ANALYZE;
SQL

log "Đổi ${DB}_new → $DB"
psql_local -d postgres <<SQL
DROP DATABASE IF EXISTS ${DB}_old WITH (FORCE);
-- Backend dev đang mở kết nối: chặn kết nối mới rồi cắt kết nối cũ (Prisma tự nối lại sau khi đổi tên)
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB') THEN
    ALTER DATABASE $DB WITH ALLOW_CONNECTIONS false;
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB';
    ALTER DATABASE $DB RENAME TO ${DB}_old;
  END IF;
END \$\$;
ALTER DATABASE ${DB}_new RENAME TO $DB;
DROP DATABASE IF EXISTS ${DB}_old WITH (FORCE);
SQL

# Giữ KEEP_DUMPS bản dump mới nhất
ls -1t "$DUMP_DIR"/*.dump | tail -n +$((KEEP_DUMPS + 1)) | while read -r old; do rm -f "$old"; done
log "Xong ($(($(date +%s) - started))s). DB local: postgresql://postgres:***@localhost:$PORT/$DB"
