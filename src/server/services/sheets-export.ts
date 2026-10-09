/**
 * Google スプレッドシートへの日次出力（大和さん・給与担当が今まで通り表で見るため）。
 * サービスアカウント（JSON 鍵ファイル）で Sheets API v4 を直接呼ぶ。鍵は環境変数のパスから読む。
 * ※ 本番の Google 側設定（サービスアカウント作成・シート共有）は大和さんの作業。未検証項目として README に記載。
 */
import { readFile } from 'node:fs/promises';
import { SignJWT, importPKCS8 } from 'jose';
import { config } from '../config.js';
import { q } from '../db.js';

export const sheetsConfigured = (): boolean => !!(config.sheets.serviceAccountFile && config.sheets.spreadsheetId);

async function accessToken(): Promise<string> {
  const sa = JSON.parse(await readFile(config.sheets.serviceAccountFile, 'utf8')) as { client_email: string; private_key: string; token_uri?: string };
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/spreadsheets' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(sa.client_email).setAudience(sa.token_uri ?? 'https://oauth2.googleapis.com/token').setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  if (!res.ok) throw new Error(`Google トークン取得失敗: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const SHEETS: Record<string, string> = {
  attendance: `SELECT work_date::text AS "勤務日", employee_id AS "従業員ID", staff_name AS "スタッフ名", department AS "部門", location_name AS "事業所",
      to_char(clock_in_at AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') AS "出勤", to_char(clock_out_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS "退勤",
      break_minutes AS "通常休憩(分)", night_break_minutes AS "深夜休憩(分)", work_minutes AS "実働(分)", night_minutes AS "深夜(分)", travel_km AS "移動km", travel_fee AS "交通費(円)",
      allowance_amount AS "手当(円)", allowance_note AS "手当メモ", meal_fee AS "まかない(円)", status AS "状態", leave_days AS "有給日数", leave_reason AS "有給理由",
      staff_comment AS "備考", correction_reason AS "修正理由", break_reason AS "法定休憩理由", gh_break_reason AS "GH休憩理由", stamp_warning_reason AS "打刻警告理由", id AS "ID"
     FROM attendance WHERE deleted_at IS NULL ORDER BY work_date DESC, clock_in_at DESC`,
  staff: `SELECT employee_id AS "従業員ID", staff_name AS "氏名", staff_kana AS "かな", active AS "在籍", email AS "メール", id AS "ID" FROM staff WHERE deleted_at IS NULL ORDER BY staff_kana`,
  locations: `SELECT location_code AS "コード", location_name AS "事業所名", department AS "事業部", sort_order AS "並び順", active AS "有効", check_alcohol AS "アルコールチェック", gh_extras AS "GH手当・まかない", gh_break_rule AS "GH休憩ルール" FROM locations WHERE deleted_at IS NULL ORDER BY sort_order`,
};

export async function exportToSheets(): Promise<string> {
  const token = await accessToken();
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.spreadsheetId}`;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const meta = await fetch(`${api}?fields=sheets.properties`, { headers: h });
  if (!meta.ok) throw new Error(`スプレッドシート取得失敗: ${meta.status} ${await meta.text()}`);
  const existing = new Set((((await meta.json()) as { sheets: Array<{ properties: { title: string } }> }).sheets ?? []).map((s) => s.properties.title));
  const missing = Object.keys(SHEETS).filter((t) => !existing.has(t));
  if (missing.length) {
    const r = await fetch(`${api}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }) });
    if (!r.ok) throw new Error(`シート追加失敗: ${r.status} ${await r.text()}`);
  }
  let total = 0;
  for (const [title, sql] of Object.entries(SHEETS)) {
    const rows = await q<Record<string, unknown>>(sql);
    const cols = rows.length ? Object.keys(rows[0]!) : [];
    const values = [cols, ...rows.map((r) => cols.map((c) => { const v = r[c]; return v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : v; }))];
    const clear = await fetch(`${api}/values/${encodeURIComponent(title)}!A:Z:clear`, { method: 'POST', headers: h, body: '{}' });
    if (!clear.ok) throw new Error(`シート消去失敗(${title}): ${clear.status}`);
    const put = await fetch(`${api}/values/${encodeURIComponent(title)}!A1?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ values }) });
    if (!put.ok) throw new Error(`シート書き込み失敗(${title}): ${put.status} ${await put.text()}`);
    total += rows.length;
  }
  return `スプレッドシート更新 ${total}行`;
}
