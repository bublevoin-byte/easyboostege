import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/*
 * public/ остаётся каталогом исходников: сервер умеет отдавать его напрямую, все тесты читают
 * именно эти файлы, а `npm start` на чистом клоне обязан работать без сборки. Vite здесь — второй,
 * необязательный путь: он собирает те же исходники в dist/public, и сервер предпочитает его,
 * если каталог существует.
 *
 * publicDir отключён намеренно. Статика лежит в самом root, а Vite не разрешает publicDir внутри
 * root; поэтому файлы, на которые никто не ссылается импортом (manifest, иконки, банк заданий,
 * offline- и privacy-страницы, service worker), копирует scripts/build-frontend.js — он же
 * подставляет в service worker хешированные имена из манифеста сборки.
 */
const projectDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: path.join(projectDirectory, 'public'),
  publicDir: false,
  base: '/',
  build: {
    outDir: path.join(projectDirectory, 'dist', 'public'),
    emptyOutDir: true,
    /*
     * Манифест — единственный способ узнать, в какой файл попал исходный модуль: имена
     * хешированные. По нему собираются APP_SHELL service worker и карта модулей, которой
     * пользуется e2e-замер производительности.
     */
    manifest: true,
    /* Приложение уже написано на нативных ES-модулях, и браузеры, которые их понимают, понимают и это. */
    target: 'es2022',
    rollupOptions: {
      input: { index: path.join(projectDirectory, 'public', 'index.html') },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        /*
         * Хеш в имени нужен ради кэша, но у двух файлов имя — часть контракта с браузером и с
         * e2e-сценарием: адрес манифеста PWA и иконки прописан в разметке и проверяется как
         * `/manifest.json`. Переименование их сломает установку приложения, а выигрыша не даст:
         * оба меняются вместе с разметкой, которая отдаётся с `Cache-Control: no-store`.
         */
        assetFileNames(asset) {
          const name = (asset.names && asset.names[0]) || asset.name || '';
          return name === 'manifest.json' || name === 'pwa-icon.svg'
            ? '[name][extname]'
            : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
