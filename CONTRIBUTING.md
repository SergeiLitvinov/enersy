# Contributing to Enersy

## Обязательные правила проекта

Для новых изменений действуют [правила разработки](docs/CODING_RULES.md). [Анализ текущего состояния](docs/PROJECT_REVIEW.md) описывает ограничения, а [TODO](TODO.md) — порядок развития и критерии приёмки. Планируемая архитектура не означает, что все её проверки и возможности уже реализованы.

Изменение расчётной модели сопровождается описанием физики, единиц, области применимости и независимым эталоном. Изменение каталога сохраняет версии и происхождение данных; изменение UI не должно менять физическую топологию.

## Project Structure

```
enersy/
├── backend-go/        # Go API Gateway
├── backend-julia/     # Julia compute service
├── frontend/          # React + Vite + TypeScript
├── rust-wasm/         # Rust → WebAssembly utilities
├── database/          # SQL migrations
├── docker-compose.yml
└── nginx.conf
```

## Development Setup

### Prerequisites

- Go 1.24+
- Node.js 20+
- Rust (wasm-pack for WASM builds)
- Docker & Docker Compose (standard full-stack runtime)

### Running Locally

For ordinary development, start the stack with Docker/Compose. Host tools are optional for focused development; they do not replace the container deployment.

**Go API (optional host development, PowerShell):**
Start PostgreSQL with Compose first. Select its host address and an explicit migration directory; `go run .` compiles all API files.
```powershell
cd backend-go
go mod download
$env:DB_HOST = 'localhost'
$migrationDirectory = (Resolve-Path ../database/migrations).Path.Replace('\', '/')
$env:MIGRATIONS_SOURCE = 'file:///' + $migrationDirectory
go run .
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

**Full stack with Docker:**
```bash
docker compose up --build
```

## Code Quality

### Go

- Run `go vet ./...` before committing
- Run `golangci-lint run` for full linting
- Keep `go.mod` and `go.sum` updated

### Frontend

- Run `npm run lint` (ESLint)
- Run `npm test` (Vitest)
- Keep dependencies in `package.json` up to date

### WASM (Rust)

```bash
cd rust-wasm
wasm-pack build --target web
```

After building, copy the output to `frontend/public/rust-wasm/`.

## Pull Request Process

1. Ensure all lints and tests pass
2. Update README.md if adding new features
3. Update API documentation for any endpoint changes
4. Add SQL migrations in `database/` for schema changes

## Environment Variables

See README.md for the full list. For local development, defaults work out of the box.

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, etc.

## Локальные инструменты Windows

На машине пользователя инструменты находятся в `C:\DevTools`: Rust — `rust/rustup/toolchains/stable-x86_64-pc-windows-gnu/bin`, MinGW — `mingw/bin`, Node — версионированные каталоги `node`. Это локальная настройка, не обязательный путь для переносимой сборки. Прежде чем загружать контейнер для проверки кода, используйте установленный toolchain; системный PATH изменять не требуется.

Для автономного численного модуля: `cargo test --manifest-path numerics/Cargo.toml --locked --offline` и `cargo clippy --manifest-path numerics/Cargo.toml --locked --offline --all-targets -- -D warnings`. Проверено на Windows Rust/Cargo 1.97.1 с MinGW. Исходники, допускающие эксперимент, находятся в `numerics/src`; solver не подключён к AC HTTP API.
