FROM node:24-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /workspace
COPY .node-version ./
RUN test "$(node --version)" = "v$(cat .node-version)"
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml typedoc.json ./
RUN pnpm install --frozen-lockfile
COPY scripts/security/collect-node-licenses.mjs /tools/collect-node-licenses.mjs
COPY scripts/security/node-notice-sources.json /tools/node-notice-sources.json
RUN node /tools/collect-node-licenses.mjs /workspace /workspace/pnpm-lock.yaml /enersy-notices/documentation.json
COPY scripts/docs ./scripts/docs
COPY docs ./docs
COPY TODO.md ./
COPY frontend/src ./frontend/src
COPY backend-go ./backend-go
COPY backend-julia/src ./backend-julia/src
COPY backend-julia/test ./backend-julia/test
COPY backend-julia/benchmark ./backend-julia/benchmark
COPY backend-julia/experimental ./backend-julia/experimental
COPY rust-wasm/src ./rust-wasm/src
COPY numerics/src ./numerics/src
COPY numerics/tests ./numerics/tests
COPY numerics/examples ./numerics/examples
COPY numerics/include ./numerics/include
COPY database ./database
RUN pnpm docs:build

FROM nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a
COPY --from=build /workspace/docs/site/.vitepress/dist /usr/share/nginx/html
COPY --from=build /enersy-notices/documentation.json /usr/share/nginx/html/licenses/npm-documentation.json
COPY LICENSE /usr/share/nginx/html/licenses/enersy-MIT.txt
EXPOSE 80
