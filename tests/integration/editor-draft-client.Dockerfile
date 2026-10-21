FROM node:20-alpine
WORKDIR /workspace/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/src ./src
COPY tests/fixtures /workspace/tests/fixtures
CMD ["node", "node_modules/vitest/vitest.mjs", "run", "src/api/editor-drafts-http.test.ts"]
