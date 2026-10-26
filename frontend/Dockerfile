FROM node:24-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

WORKDIR /app

COPY .node-version ./
RUN test "$(node --version)" = "v$(cat .node-version)"

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY scripts/security/collect-node-licenses.mjs /tools/collect-node-licenses.mjs
COPY scripts/security/node-notice-sources.json /tools/node-notice-sources.json
RUN node /tools/collect-node-licenses.mjs /app /app/package-lock.json /enersy-notices/frontend.json

COPY frontend/src ./src
COPY frontend/index.html ./
COPY frontend/vite.config.ts ./
COPY frontend/tsconfig.json ./
COPY frontend/public ./public

RUN npm run build

FROM builder AS check
# Cross-language contract tests read these versioned sources directly. Keep the
# check image self-contained; the production runtime still copies builder/dist.
COPY frontend/eslint.config.mjs ./
COPY backend-julia/src /backend-julia/src
COPY tests/fixtures /tests/fixtures
COPY database/migrations /database/migrations
RUN npm run typecheck && npm run lint && npm test

FROM nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /enersy-notices/frontend.json /usr/share/nginx/html/licenses/npm-frontend.json
COPY LICENSE /usr/share/nginx/html/licenses/enersy-MIT.txt
COPY frontend/nginx-default.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
