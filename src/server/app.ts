/**
 * Fastify アプリ組み立て（テストからも使う）。
 * - エラーは HTTP ステータス＋ {error, code, field} で返し、理由をそのまま画面に出せるようにする
 * - 画面（dist/web）は HTML を no-cache、ハッシュ付き資産は長期キャッシュ
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { AppError } from './errors.js';
import { config, APP_VERSION } from './config.js';
import { kioskRoutes } from './routes/kiosk.js';
import { myRoutes } from './routes/my.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true, bodyLimit: 256 * 1024 });

  await app.register(cookie, { secret: config.sessionSecret || 'dev-only-secret-change-me-0123456789' });
  await app.register(rateLimit, { global: true, max: config.rateLimitMax, timeWindow: '1 minute', keyGenerator: (req) => req.ip });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.message, code: err.code, field: err.field, ...(err.extra ?? {}) });
    }
    const e = err as { statusCode?: number; validation?: unknown; message?: string; code?: string };
    if (e.validation) return reply.status(400).send({ error: `入力内容が正しくありません：${e.message ?? ''}`, code: 'VALIDATION' });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'アクセスが集中しています。少し待ってからもう一度お試しください', code: 'RATE_LIMIT' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message ?? 'リクエストが不正です', code: e.code ?? 'BAD_REQUEST' });
    req.log.error(err);
    return reply.status(500).send({ error: `サーバーでエラーが起きました（${e.code ?? 'INTERNAL'}）。時間をおいて再度お試しください。続く場合は管理者に連絡してください`, code: 'INTERNAL' });
  });

  app.get('/api/version', async () => ({ version: APP_VERSION, server_time: new Date().toISOString() }));
  app.get('/api/health', async () => ({ ok: true }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(kioskRoutes, { prefix: '/api/kiosk' });
  await app.register(myRoutes, { prefix: '/api/my' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // 画面（ビルド済み）
  const webDir = path.resolve(config.webDir);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('manifest.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/\/assets\//.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'APIが見つかりません', code: 'NOT_FOUND' });
      return reply.status(404).type('text/html; charset=utf-8').send('<meta charset="utf-8"><p>ページが見つかりません。<a href="/">トップへ</a></p>');
    });
  }
  return app;
}
