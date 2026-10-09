#!/usr/bin/env bash
# =============================================================================
# だいずスマイルファクトリー タイムカード：ConoHa VPS（Ubuntu 22.04/24.04）初期セットアップ
#
# 使い方（VPS に root でログインして1回だけ実行）：
#   sudo apt-get update && sudo apt-get install -y gh
#   gh auth login --hostname github.com --git-protocol https --web   ← 表示されたコードをブラウザで入力
#   gh repo clone yamato-cloud/daizu-timecard /opt/daizu-timecard
#   sudo bash /opt/daizu-timecard/deploy/setup.sh timecard.daizu.info
#
# やること：Node.js 22 / PostgreSQL / Caddy（https 自動）/ gh を入れ、アプリを /opt/daizu-timecard に置き、
#          DB とユーザーを作り、.env を生成し、ビルドして systemd サービスとして起動する。
# 何度実行しても壊れない（既にある物は飛ばす）。
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-yamato-cloud/daizu-timecard}"
APP_DIR="/opt/daizu-timecard"
APP_USER="daizu"
DB_NAME="daizu_timecard"
DB_USER="daizu"

if [ -z "$DOMAIN" ]; then echo "使い方: sudo bash setup.sh <ドメイン名 例: timecard.daizu.info>"; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo "root（sudo）で実行してください"; exit 1; fi

echo "== 1/8 パッケージ =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y && apt-get install -y caddy
fi

if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y && apt-get install -y gh
fi

echo "== 2/8 ファイアウォール（22/80/443 だけ開ける）=="
ufw allow OpenSSH >/dev/null || true
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "== 3/8 アプリ用ユーザーと DB =="
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
systemctl enable --now postgresql
DB_PASS_FILE="/etc/daizu-timecard.dbpass"
if [ ! -f "$DB_PASS_FILE" ]; then openssl rand -hex 24 > "$DB_PASS_FILE"; chmod 600 "$DB_PASS_FILE"; fi
DB_PASS="$(cat "$DB_PASS_FILE")"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

echo "== 4/8 ソースコード（GitHub から取得）=="
if [ ! -d "$APP_DIR/.git" ]; then
  if ! gh auth status >/dev/null 2>&1; then
    echo "GitHub にログインします。表示されるコード（XXXX-XXXX）をブラウザの https://github.com/login/device に入力してください"
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git
  gh repo clone "$REPO" "$APP_DIR"
fi
gh auth setup-git >/dev/null 2>&1 || true
git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true

echo "== 5/8 .env（秘密情報。初回だけ生成）=="
if [ ! -f "$APP_DIR/.env" ]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  EMERGENCY="$(openssl rand -hex 24)"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
APP_BASE_URL=https://$DOMAIN
DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost/$DB_NAME
SESSION_SECRET=$SESSION_SECRET
ADMIN_EMAILS=yamato@daizu.info
# Google ログイン（README の手順で取得して貼る）
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Google が使えないときの緊急ログイン用トークン（管理画面の「緊急ログイン」に貼る）
ADMIN_EMERGENCY_TOKEN=$EMERGENCY
# メール送信（README の手順で設定）
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=だいずタイムカード <no-reply@daizu.info>
# 任意
GOOGLE_SERVICE_ACCOUNT_FILE=
EXPORT_SPREADSHEET_ID=
LW_CLIENT_ID=
LW_CLIENT_SECRET=
LW_SERVICE_ACCOUNT=
LW_PRIVATE_KEY=
LW_BOT_ID=
LW_CHANNEL_ID=
BACKUP_DIR=/var/lib/daizu-timecard/backups
OUTBOX_DIR=/var/lib/daizu-timecard/outbox
ENABLE_JOBS=true
WEB_DIR=dist/web
EOF
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
mkdir -p /var/lib/daizu-timecard/backups /var/lib/daizu-timecard/outbox
chown -R "$APP_USER:$APP_USER" /var/lib/daizu-timecard

echo "== 6/8 ビルド =="
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
sudo -u "$APP_USER" npm run migrate
chown -R "$APP_USER:$APP_USER" "$APP_DIR/dist"

echo "== 7/8 systemd サービス =="
cp "$APP_DIR/deploy/daizu-timecard.service" /etc/systemd/system/daizu-timecard.service
systemctl daemon-reload
systemctl enable --now daizu-timecard
systemctl restart daizu-timecard
sleep 2
systemctl --no-pager --lines=5 status daizu-timecard || true

echo "== 8/8 Caddy（https）=="
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo
echo "=============================================================="
echo " セットアップ完了：https://$DOMAIN"
echo " 緊急ログイン用トークン（管理画面の「緊急ログイン」に貼る。控えてください）："
grep ADMIN_EMERGENCY_TOKEN "$APP_DIR/.env" | cut -d= -f2
echo
echo " 次にやること："
echo "  1) 起動PIN を設定：  cd $APP_DIR && sudo -u $APP_USER npm run cli -- set-gate-pin 1234"
echo "  2) 給与送信先：      cd $APP_DIR && sudo -u $APP_USER npm run cli -- set-setting payroll_notify_emails yamato@daizu.info"
echo "  3) ブラウザで https://$DOMAIN/admin.html を開いて緊急ログイン → スタッフ・事業所を登録（または旧データを取り込み）"
echo "=============================================================="
