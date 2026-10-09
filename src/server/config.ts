/**
 * 環境変数（秘密情報はここからだけ読む。ソースに書かない）。
 * .env.example に一覧がある。
 */
import 'dotenv/config';

const env = (k: string, def = ''): string => (process.env[k] ?? def).trim();
const bool = (k: string, def = false): boolean => { const v = env(k); return v === '' ? def : /^(1|true|yes|on)$/i.test(v); };

export const APP_VERSION = env('APP_VERSION', process.env.npm_package_version ?? '0.1.0');

export const config = {
  env: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV') === 'production',
  port: Number(env('PORT', '3000')),
  host: env('HOST', '127.0.0.1'),
  /** 本番の公開URL（メールのリンク・Google ログインのリダイレクトに使う） */
  baseUrl: env('APP_BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: env('DATABASE_URL', 'postgres://localhost/daizu_timecard'),
  /** Cookie 署名用の秘密。32文字以上のランダム文字列 */
  sessionSecret: env('SESSION_SECRET'),
  /** 管理者 Google ログイン */
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  },
  /** 管理者として許可するメール（カンマ区切り）。settings.admin_emails と合算 */
  adminEmails: env('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Google ログインが使えないときの緊急ログイン用トークン（未設定なら無効） */
  adminEmergencyToken: env('ADMIN_EMERGENCY_TOKEN'),
  /** メール送信（SMTP）。未設定なら outbox/ にファイルとして書き出す（開発用） */
  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM', 'タイムカード <no-reply@localhost>'),
    secure: bool('SMTP_SECURE', false),
  },
  /** LINE WORKS Bot（大吉通知）。鍵は必ずここ（環境変数）に置く */
  lineworks: {
    clientId: env('LW_CLIENT_ID'),
    clientSecret: env('LW_CLIENT_SECRET'),
    serviceAccount: env('LW_SERVICE_ACCOUNT'),
    privateKey: env('LW_PRIVATE_KEY').replace(/\\n/g, '\n'),
    botId: env('LW_BOT_ID'),
    channelId: env('LW_CHANNEL_ID'),
  },
  /** Google スプレッドシート出力（サービスアカウント JSON のパス）。未設定なら CSV バックアップのみ */
  sheets: {
    serviceAccountFile: env('GOOGLE_SERVICE_ACCOUNT_FILE'),
    spreadsheetId: env('EXPORT_SPREADSHEET_ID'),
  },
  backupDir: env('BACKUP_DIR', 'backups'),
  outboxDir: env('OUTBOX_DIR', 'outbox'),
  /** 定期処理を動かすか（テスト時は false） */
  enableJobs: bool('ENABLE_JOBS', true),
  /** 全体のレート制限（IP ごと・1分あたり）。据え置き端末が同じ回線に複数ある前提で余裕を持たせる */
  rateLimitMax: Number(env('RATE_LIMIT_MAX', '600')),
  /** テスト用：レート制限を無効化 */
  rateLimitDisabled: bool('RATE_LIMIT_DISABLED', false),
  /** 公開ディレクトリ（ビルド済み画面） */
  webDir: env('WEB_DIR', 'dist/web'),
};

export function assertConfig(): string[] {
  const problems: string[] = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) problems.push('SESSION_SECRET は32文字以上のランダム文字列にしてください');
  if (config.isProd && !config.google.clientId && !config.adminEmergencyToken) problems.push('GOOGLE_CLIENT_ID（または ADMIN_EMERGENCY_TOKEN）が未設定のため管理画面にログインできません');
  if (config.isProd && !config.baseUrl.startsWith('https://')) problems.push('APP_BASE_URL は https:// で始まる本番URLにしてください');
  return problems;
}

/** ルート個別のレート制限（1分あたり n 回）。テストでは無効化 */
export const routeLimit = (n: number) => ({ rateLimit: { max: config.rateLimitDisabled ? 1_000_000 : n, timeWindow: '1 minute' } });
