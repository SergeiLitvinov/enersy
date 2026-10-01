FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml typedoc.json ./
RUN pnpm install --frozen-lockfile
COPY scripts/docs ./scripts/docs
COPY docs ./docs
COPY TODO.md ./
COPY frontend/src ./frontend/src
COPY backend-go ./backend-go
COPY backend-julia/src ./backend-julia/src
COPY backend-julia/test ./backend-julia/test
COPY rust-wasm/src ./rust-wasm/src
COPY numerics/src ./numerics/src
COPY numerics/tests ./numerics/tests
COPY database ./database
RUN pnpm docs:build

FROM nginx:1.28-alpine
COPY --from=build /workspace/docs/site/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
