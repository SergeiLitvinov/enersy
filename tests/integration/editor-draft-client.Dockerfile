FROM node:24-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /workspace/frontend
COPY .node-version ./
RUN test "$(node --version)" = "v$(cat .node-version)"
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/src ./src
COPY tests/fixtures /workspace/tests/fixtures
CMD ["node", "node_modules/vitest/vitest.mjs", "run", "src/api/editor-drafts-http.test.ts"]
