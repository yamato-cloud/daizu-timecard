import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 画面は src/web。ビルドは dist/web（資産はハッシュ付きファイル名：版数は1か所＝ビルド）
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  publicDir: resolve(__dirname, 'src/web/public'),
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/web/index.html'),
        my: resolve(__dirname, 'src/web/my.html'),
        admin: resolve(__dirname, 'src/web/admin.html'),
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
