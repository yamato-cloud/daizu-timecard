/** サーバー起動：マイグレーション → 設定チェック → HTTP → 定期処理 */
import { buildApp } from './app.js';
import { migrate, closeDb } from './db.js';
import { config, assertConfig, APP_VERSION } from './config.js';
import { startScheduler } from './jobs.js';

const problems = assertConfig();
for (const p of problems) console.error(`[config] ${p}`);
if (problems.length && config.isProd) process.exit(1);

const applied = await migrate();
if (applied.length) console.log(`[db] マイグレーション適用: ${applied.join(', ')}`);

const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.host });
console.log(`[server] v${APP_VERSION} http://${config.host}:${config.port} (${config.env})`);

if (config.enableJobs) startScheduler();

const shutdown = async () => { await app.close(); await closeDb(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
