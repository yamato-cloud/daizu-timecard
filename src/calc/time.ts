/**
 * 時刻・日付の小さな純粋関数。I/O なし・タイムゾーン依存なし。
 * 日付は 'YYYY-MM-DD'、時刻は 'HH:MM'、分は「その日の 0:00 からの分」。
 */

/** 'HH:MM' → 分。形式不正は null */
export function toMin(t: string | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分 → 'HH:MM'（1440 を超える分は翌日として折り返す） */
export function toHHMM(min: number): string {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidDate(s: string | null | undefined): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''))) return false;
  const [y, mo, d] = String(s).split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 'YYYY-MM-DD' に n 日足す */
export function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = String(dateStr).split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → 'YYYY-MM' */
export function ymOf(dateStr: string): string {
  return String(dateStr).slice(0, 7);
}

/** 'YYYY-MM' の前月 */
export function prevYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' → [初日, 末日] */
export function ymRange(ym: string): [string, string] | null {
  const m = String(ym ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

/** 分 → 'X時間Y分' */
export function minToHM(min: number): string {
  const v = Math.max(0, Math.round(min));
  return `${Math.floor(v / 60)}時間${v % 60}分`;
}

/**
 * 分 → 小数時間の文字列（給与集計CSV用）。
 * 1時間=1。小数第3位以下は切り捨て（過大計上しない）。分の段階で整数計算して浮動小数誤差を避ける。
 * 例: 480→'8.00' / 485→'8.08' / 90→'1.50' / 59→'0.98'
 */
export function minToDecimalHours(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(Number(min))) return '';
  const v = Math.floor(Number(min) * 100 / 60) / 100;
  return v.toFixed(2);
}

/** 全種類の空白を除去（氏名・かなの表記ゆれ防止） */
export function stripSpaces(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\s　]+/g, '');
}

/** 従業員番号を3桁ゼロ埋めの文字列に正規化（数字以外はそのまま） */
export function padEmpId(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (!/^\d+$/.test(s)) return s;
  const n = parseInt(s, 10);
  return String(n).length >= 3 ? String(n) : ('00' + String(n)).slice(-3);
}

/** JST の 'YYYY-MM-DD' / 'HH:MM' を UTC ミリ秒へ */
export function jstToMs(dateStr: string, hhmm: string): number | null {
  const mi = toMin(hhmm);
  if (!isValidDate(dateStr) || mi === null) return null;
  const [y, mo, d] = dateStr.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d, Math.floor(mi / 60) - 9, mi % 60);
}

/** UTC ミリ秒 → JST の {date:'YYYY-MM-DD', time:'HH:MM'} */
export function msToJst(ms: number): { date: string; time: string } {
  const d = new Date(ms + 9 * 3600 * 1000);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { date, time };
}
