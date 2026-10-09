/**
 * 管理者ログイン：Google アカウント（許可メール2名）／緊急トークン（環境変数、Google が使えないときだけ）。
 * 10回失敗で5分ロック（IP 単位）。
 */
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { routeLimit } from '../config.js';
import { createSession, destroySession, readSession, isAdminEmail, assertEmergencyToken, checkGateLock, recordFailure, clearFailures } from '../auth.js';
import { forbidden } from '../errors.js';
import { audit } from '../audit.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const STATE_COOKIE = 'dsf_oauth_state';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/me', async (req, reply) => {
    const s = await readSession(req, reply, 'admin');
    return { logged_in: !!s, email: s?.subject ?? null, label: s?.label ?? null, google_enabled: !!config.google.clientId, emergency_enabled: !!config.adminEmergencyToken };
  });

  /** Google ログイン開始 → Google の画面へ */
  app.get('/google/start', async (_req, reply) => {
    if (!config.google.clientId) throw forbidden('Google ログインが設定されていません（GOOGLE_CLIENT_ID 未設定）', 'GOOGLE_DISABLED');
    const state = randomBytes(16).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 600 });
    const u = new URL(GOOGLE_AUTH);
    u.searchParams.set('client_id', config.google.clientId);
    u.searchParams.set('redirect_uri', `${config.baseUrl}/api/auth/google/callback`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    return reply.redirect(u.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/google/callback', async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`/admin.html?login_error=${encodeURIComponent(msg)}`);
    if (req.query.error) return fail(`Google ログインが中止されました（${req.query.error}）`);
    const state = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth' });
    if (!state || state !== req.query.state) return fail('ログインの確認情報が一致しません。もう一度お試しください');
    if (!req.query.code) return fail('認証コードがありません');
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.baseUrl}/api/auth/google/callback`, grant_type: 'authorization_code' }),
    });
    if (!res.ok) { req.log.error({ status: res.status, body: await res.text() }, 'google token exchange failed'); return fail('Google からトークンを取得できませんでした（設定の Client Secret / リダイレクトURI を確認）'); }
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) return fail('Google から ID トークンが返りませんでした');
    let email = '';
    let name = '';
    try {
      const { payload } = await jwtVerify(tok.id_token, GOOGLE_JWKS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.google.clientId });
      if (!payload['email_verified']) return fail('メールアドレスが確認済みの Google アカウントでログインしてください');
      email = String(payload['email'] ?? '').toLowerCase();
      name = String(payload['name'] ?? email);
    } catch (e) { req.log.error(e, 'id_token verify failed'); return fail('Google の ID トークンを検証できませんでした'); }
    if (!(await isAdminEmail(email))) {
      await audit({ kind: 'system', id: 'auth', label: 'auth', ip: req.ip }, 'admin.login_denied', email, null, null);
      return fail(`${email} は管理者として登録されていません（管理者2名のメールだけが使えます）`);
    }
    await createSession('admin', email, name, { via: 'google' }, reply);
    await audit({ kind: 'admin', id: email, label: name, ip: req.ip }, 'admin.login', email, null, { via: 'google' });
    return reply.redirect('/admin.html');
  });

  /** 緊急ログイン（Google が使えないとき）。環境変数 ADMIN_EMERGENCY_TOKEN と一致した場合のみ */
  app.post<{ Body: { token?: string; email?: string } }>('/emergency', { config: routeLimit(20) }, async (req, reply) => {
    const key = req.ip;
    await checkGateLock('admin', key);
    try {
      assertEmergencyToken(String(req.body?.token ?? ''));
    } catch (e) {
      await recordFailure('admin', key, 10, 5 * 60e3);
      throw e;
    }
    await clearFailures('admin', key);
    const email = String(req.body?.email ?? 'emergency@local').toLowerCase();
    await createSession('admin', email, '緊急ログイン', { via: 'emergency' }, reply);
    await audit({ kind: 'admin', id: email, label: '緊急ログイン', ip: req.ip }, 'admin.login', email, null, { via: 'emergency' });
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => { await destroySession(req, reply, 'admin'); return { ok: true }; });

}
