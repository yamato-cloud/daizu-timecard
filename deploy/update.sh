#!/usr/bin/env bash
# 更新：GitHub の最新を取り込み → ビルド → マイグレーション → 再起動。
#   sudo bash /opt/daizu-timecard/deploy/update.sh
set -euo pipefail
APP_DIR="/opt/daizu-timecard"
cd "$APP_DIR"
echo "== 取得 =="; git pull --ff-only
echo "== ビルド =="; npm ci --no-audit --no-fund; npm run build; chown -R daizu:daizu "$APP_DIR/dist"
echo "== DB 更新 =="; sudo -u daizu -H npm run migrate
echo "== 再起動 =="; systemctl restart daizu-timecard; sleep 2
systemctl --no-pager --lines=3 status daizu-timecard
echo "== 版 =="; curl -s http://127.0.0.1:3000/api/version; echo
