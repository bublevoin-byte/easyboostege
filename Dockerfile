# Стадия сборки frontend. Существует ровно затем, чтобы содержимое образа определялось
# репозиторием, а не тем, что лежит в рабочем каталоге на машине владельца: `dist/` исключён
# в `.dockerignore` и в контекст сборки не попадает вовсе.
#
# NODE_ENV здесь намеренно не production. `vite` живёт в devDependencies, и при
# NODE_ENV=production `npm ci` молча пропустил бы его — собирать frontend стало бы нечем,
# а образ снова поехал бы из `public/`.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app
# Браузеры Playwright нужны только e2e-прогонам; в стадии сборки это сотни мегабайт загрузки,
# которыми никто не пользуется, и лишний повод для падения сборки на чужой сети.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

# Ровно то, из чего собирается frontend: правка в server.js или в тестах не должна
# переигрывать сборку.
COPY vite.config.js ./
COPY scripts/build-frontend.js ./scripts/build-frontend.js
COPY public ./public
# Скрипт собирает в dist/public.building и переносит готовое в dist/public последним шагом,
# поэтому дальше копируется только законченная сборка.
RUN npm run build:frontend

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
COPY --from=frontend-build --chown=node:node /app/dist/public ./dist/public
RUN mkdir -p /app/tts-cache && chown node:node /app/tts-cache

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start:production"]
