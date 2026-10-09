/**
 * 認証：PIN ハッシュ（scrypt＋ソルト）、セッション（DB）、起動PIN（端末ごと 5回で5分ロック）、
 * 管理者（Google アカウント／緊急トークン）。権限判定はここと routes のガードだけが持つ。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, q, pool, type Queryable } from './db.js';
import { config } from './config.js';
import { forbidden, tooMany, unauthorized } from './errors.js';
import { getSetting, parseEmails } from './settings.js';

// ---------- ハッシュ ----------
export function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** 新方式：scrypt。形式 "s1$<salt hex>$<hash hex>" */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  const h = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `s1$${salt}$${h}`;
}
export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [v, salt, h] = stored.split('$');
  if (v !== 's1' || !salt || !h) return false;
  const calc = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex');
  return calc.length === want.length && timingSafeEqual(calc, want);
}
/** 旧方式（ソルトなし SHA-256 の16進64文字） */
export function verifyLegacyPin(pin: string, legacyHash: string | null | undefined): boolean {
  if (!legacyHash || legacyHash.length !== 64) return false;
  const a = Buffer.from(sha256Hex(pin), 'hex');
  const b = Buffer.from(legacyHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function isValidPin(pin: unknown): pin is string { return typeof pin === 'string' && /^\d{4}$/.test(pin); }

// ---------- セッション ----------
export type SessionKind = 'admin' | 'staff' | 'kiosk';
export interface Session { kind: SessionKind; subject: string; label: string | null; meta: Record<string, unknown>; expires_at: Date }

const COOKIE: Record<SessionKind, string> = { admin: 'dsf_admin', staff: 'dsf_staff', kiosk: 'dsf_kiosk' };
const TTL_MS: Record<SessionKind, number> = { admin: 8 * 3600e3, staff: 30 * 60e3, kiosk: 180 * 24 * 3600e3 };
/** 使うたびに延長（スライディング） */
const SLIDING: Record<SessionKind, boolean> = { admin: true, staff: true, kiosk: true };

export async function createSession(kind: SessionKind, subject: string, label: string | null, meta: Record<string, unknown>, reply: FastifyReply, client: Queryable = pool): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_MS[kind]);
  await client.query('INSERT INTO sessions (token_hash, kind, subject, label, meta, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [sha256Hex(token), kind, subject, label, JSON.stringify(meta), expires]);
  setCookie(reply, kind, token, expires);
  return token;
}
function setCookie(reply: FastifyReply, kind: SessionKind, token: string, expires: Date) {
  reply.setCookie(COOKIE[kind], token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd, expires });
}
export async function readSession(req: FastifyRequest, reply: FastifyReply, kind: SessionKind): Promise<Session | null> {
  const token = req.cookies[COOKIE[kind]];
  if (!token) return null;
  const s = await one<Session & { token_hash: string }>('SELECT token_hash, kind, subject, label, meta, expires_at FROM sessions WHERE token_hash = $1 AND kind = $2 AND expires_at > now()', [sha256Hex(token), kind]);
  if (!s) return null;
  if (SLIDING[kind] && s.expires_at.getTime() - Date.now() < TTL_MS[kind] / 2) {
    const expires = new Date(Date.now() + TTL_MS[kind]);
    await q('UPDATE sessions SET expires_at = $2, last_seen = now() WHERE token_hash = $1', [s.token_hash, expires]);
    setCookie(reply, kind, token, expires);
  }
  return s;
}
export async function destroySession(req: FastifyRequest, reply: FastifyReply, kind: SessionKind): Promise<void> {
  const token = req.cookies[COOKIE[kind]];
  if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
  reply.clearCookie(COOKIE[kind], { path: '/' });
}
export async function purgeExpiredSessions(): Promise<void> {
  await q('DELETE FROM sessions WHERE expires_at < now()');
}

// ---------- ガード ----------
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<Session> {
  const s = await readSession(req, reply, 'admin');
  if (!s) throw unauthorized('管理者としてログインしてください', 'ADMIN_LOGIN_REQUIRED');
  return s;
}
export async function requireStaff(req: FastifyRequest, reply: FastifyReply): Promise<Session> {
  const s = await readSession(req, reply, 'staff');
  if (!s) throw unauthorized('氏名と暗証番号でログインしてください', 'STAFF_LOGIN_REQUIRED');
  return s;
}
/** 打刻端末：起動PINを通った端末だけ（端末登録トークン）。設定の起動PIN版数が変わると無効 */
export async function requireKiosk(req: FastifyRequest, reply: FastifyReply): Promise<Session> {
  const s = await readSession(req, reply, 'kiosk');
  if (!s) throw unauthorized('この端末は起動PINの確認が必要です', 'GATE_REQUIRED');
  const ver = await getSetting('site_gate_version', '1');
  if (String(s.meta['gate_version'] ?? '') !== ver) {
    await destroySession(req, reply, 'kiosk');
    throw unauthorized('起動PINが変更されました。もう一度入力してください', 'GATE_REQUIRED');
  }
  return s;
}

// ---------- 起動PIN（サイトゲート）：その端末だけ・5回失敗で5分ロック ----------
export const GATE_MAX_FAILS = 5;
export const GATE_LOCK_MS = 5 * 60e3;
const DEVICE_COOKIE = 'dsf_device';

/**
 * 端末識別子（Cookie）。無ければ発行する。
 * ロックの単位：Cookie を持つ端末は「その端末だけ」。Cookie を送ってこない相手（Cookie 拒否・API 直叩き）は
 * 毎回別端末になってロックが効かないので、その場合は IP 単位でロックする（安全装置を Cookie の保存に依存させない）。
 */
export function deviceKey(req: FastifyRequest, reply: FastifyReply): string {
  const id = req.cookies[DEVICE_COOKIE];
  if (id && /^[A-Za-z0-9_-]{16,64}$/.test(id)) return `dev:${id}`;
  const fresh = randomBytes(18).toString('base64url');
  reply.setCookie(DEVICE_COOKIE, fresh, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 400 * 24 * 3600 });
  return `ip:${req.ip}`;
}

export async function checkGateLock(scope: 'gate' | 'admin', key: string): Promise<void> {
  const r = await one<{ fail_count: number; locked_until: Date | null }>('SELECT fail_count, locked_until FROM auth_failures WHERE scope = $1 AND key = $2', [scope, key]);
  if (r?.locked_until && r.locked_until.getTime() > Date.now()) {
    const sec = Math.ceil((r.locked_until.getTime() - Date.now()) / 1000);
    throw tooMany(`入力を${GATE_MAX_FAILS}回間違えたため、この端末ではあと${Math.ceil(sec / 60)}分ロックされています`, 'GATE_LOCKED', { retry_after_sec: sec });
  }
}
export async function recordFailure(scope: 'gate' | 'admin', key: string, maxFails = GATE_MAX_FAILS, lockMs = GATE_LOCK_MS): Promise<number> {
  const r = await one<{ fail_count: number }>(
    `INSERT INTO auth_failures (scope, key, fail_count, updated_at) VALUES ($1,$2,1,now())
     ON CONFLICT (scope, key) DO UPDATE SET fail_count = CASE WHEN auth_failures.locked_until IS NOT NULL AND auth_failures.locked_until < now() THEN 1 ELSE auth_failures.fail_count + 1 END, locked_until = NULL, updated_at = now()
     RETURNING fail_count`, [scope, key]);
  const n = r?.fail_count ?? 1;
  if (n >= maxFails) {
    await q('UPDATE auth_failures SET locked_until = $3, fail_count = 0 WHERE scope = $1 AND key = $2', [scope, key, new Date(Date.now() + lockMs)]);
  }
  return n;
}
export async function clearFailures(scope: 'gate' | 'admin', key: string): Promise<void> {
  await q('DELETE FROM auth_failures WHERE scope = $1 AND key = $2', [scope, key]);
}

export async function verifyGatePin(pin: string): Promise<boolean> {
  const stored = await getSetting('site_gate_pin_hash', '');
  if (!stored) return false;
  return verifyPin(pin, stored);
}

// ---------- 管理者 ----------
export async function isAdminEmail(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  const fromSettings = parseEmails(await getSetting('admin_emails', ''));
  return config.adminEmails.includes(e) || fromSettings.includes(e);
}
export function assertEmergencyToken(token: string): void {
  const want = config.adminEmergencyToken;
  if (!want || !token) throw forbidden('緊急ログインは無効です', 'EMERGENCY_DISABLED');
  const a = Buffer.from(sha256Hex(token));
  const b = Buffer.from(sha256Hex(want));
  if (!timingSafeEqual(a, b)) throw unauthorized('トークンが違います', 'BAD_TOKEN');
}

/** 新しいランダムトークン（退勤忘れURL等） */
export function newToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
