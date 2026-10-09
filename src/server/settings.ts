/** settings テーブル（key/value）。短時間キャッシュ。宛先・時刻・単価は設定で変えられる */
import { q, one, type Queryable, pool } from './db.js';

let cache: Record<string, string> | null = null;
let cacheAt = 0;
const TTL = 10_000;

export async function allSettings(force = false): Promise<Record<string, string>> {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}
export async function getSetting(key: string, def = ''): Promise<string> {
  const s = await allSettings();
  return s[key] ?? def;
}
export async function getNumberSetting(key: string, def: number): Promise<number> {
  const v = Number(await getSetting(key, String(def)));
  return Number.isFinite(v) ? v : def;
}
export async function setSetting(key: string, value: string, by: string, client: Queryable = pool): Promise<void> {
  await client.query(
    'INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1,$2,now(),$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by',
    [key, value, by],
  );
  cache = null;
}
export async function settingExists(key: string): Promise<boolean> {
  return !!(await one('SELECT 1 FROM settings WHERE key = $1', [key]));
}
export function invalidateSettings(): void { cache = null; }

/** 画面に公開してよい設定だけ */
export const PUBLIC_SETTING_KEYS = ['company_name', 'travel_fee_per_km', 'meal_unit_price'] as const;
/** 管理画面で編集できる設定（秘密は含めない） */
export const ADMIN_EDITABLE_KEYS = [
  'company_name', 'travel_fee_per_km', 'meal_unit_price',
  'payroll_notify_emails', 'admin_notify_emails', 'admin_emails',
  'payroll_send_day', 'payroll_send_hour', 'checkout_reminder_hour', 'backup_hour', 'backup_keep_days',
  'report_blocked_emails', 'app_base_url',
] as const;

export function parseEmails(s: string | undefined | null): string[] {
  return String(s ?? '').split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
}
