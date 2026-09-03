ARG EASYBOOST_NODE_BASE_IMAGE

# Стадия сборки frontend. Существует ровно затем, чтобы содержимое образа определялось
# репозиторием, а не тем, что лежит в рабочем каталоге на машине владельца: `dist/` исключён
# в `.dockerignore` и в контекст сборки не попадает вовсе.
#
# NODE_ENV здесь намеренно не production. `vite` живёт в devDependencies, и при
# NODE_ENV=production `npm ci` молча пропустил бы его — собирать frontend стало бы нечем,
# а образ снова поехал бы из `public/`.
FROM ${EASYBOOST_NODE_BASE_IMAGE} AS frontend-build

WORKDIR /app
# Браузеры Playwright нужны только e2e-прогонам; в стадии сборки это сотни мегабайт загрузки,
# которыми никто не пользуется, и лишний повод для падения сборки на чужой сети.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

# Ровно то, из чего собирается frontend: правка в server.js или в тестах не должна
# переигрывать сборку.
COPY vite.config.js ./
COPY scripts/build-frontend.js scripts/pwa-release-version.js scripts/pwa-predecessor-compat.js scripts/verify-release-artifact.js ./scripts/
COPY scripts/posix-session-supervisor.js scripts/release-command-supervisor.js ./scripts/
COPY scripts/posix-release-maintenance-launcher.sh scripts/posix-release-maintenance-scope.js scripts/staging-quiescent-maintenance.js ./scripts/
COPY pwa-compat ./pwa-compat
COPY public ./public
COPY shared ./shared
# Скрипт собирает в dist/public.building и переносит готовое в dist/public последним шагом,
# поэтому дальше копируется только законченная сборка.
RUN npm run build:frontend

FROM ${EASYBOOST_NODE_BASE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime image allowlist. Backend domain modules still import shared catalog contracts and
# immutable task assets from `public/`; `.dockerignore` excludes named non-runtime categories.
# Before any candidate build, the release gate walks every non-stage COPY input and fails closed if
# a reachable file is neither tracked nor explicitly listed in the audited candidate manifest.
COPY --chown=node:node config.js db.js server.js ./
COPY --chown=node:node adaptive-learning ./adaptive-learning
COPY --chown=node:node ai ./ai
COPY --chown=node:node audio ./audio
COPY --chown=node:node ege-mock ./ege-mock
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node observability ./observability
COPY --chown=node:node public ./public
COPY --chown=node:node reading ./reading
COPY --chown=node:node routes ./routes
COPY --chown=node:node security ./security
COPY --chown=node:node services ./services
COPY --chown=node:node shared ./shared
COPY --chown=node:node speaking ./speaking
COPY --chown=node:node storage ./storage
COPY --chown=node:node validation ./validation
COPY --chown=node:node voice-tutor ./voice-tutor
COPY --chown=node:node scripts/bounded-child-lifecycle.js scripts/database-operation-lock.js scripts/host-operation-lock.js scripts/import-json.js scripts/migrate.js scripts/posix-session-supervisor.js scripts/production-import-local-child-authority.js scripts/release-command-supervisor.js ./scripts/
COPY --from=frontend-build --chown=node:node /app/dist/public ./dist/public
RUN mkdir -p /app/tts-cache && chown node:node /app/tts-cache

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start:production"]
