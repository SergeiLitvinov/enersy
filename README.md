# Enersy — Система расчёта режимов электроэнергетических систем

Открытая платформа для моделирования энергосистем: редактор схем, справочник оборудования и развиваемое расчётное ядро.

**Статус на 2026-09-29:** текущая реализация — прототип. Статический анализ выявил критические ограничения топологии и расчётных методов; инженерная достоверность результатов ещё не подтверждена. Переходные процессы и полные динамические модели машин предстоит реализовать. Описания возможностей ниже отражают существующие заготовки и интерфейсы, а не сертифицированное или численно верифицированное покрытие.

- [Анализ кода и целевая архитектура](docs/PROJECT_REVIEW.md)
- [Правила разработки](docs/CODING_RULES.md)
- [Поэтапный TODO с критериями приёмки](TODO.md)

## Web-документация

`docker compose --profile docs up -d --build docs` собирает руководство и справочник кода; сайт доступен на [localhost:4173](http://localhost:4173). Для разработки: `pnpm install --frozen-lockfile`, затем `pnpm docs:dev`. Команда `pnpm docs:build` проверяет генератор, обновляет TypeDoc и справочник Go/Julia/Rust/SQL, проверяет ссылки и создаёт статический сайт. Подробнее: [обновление документации](docs/site/development/documentation.md).

На 2026-09-30 новый пакет Julia проходит аналитические и контрактные тесты; расчёт симметричного AC-режима остаётся экспериментальным до независимой сетевой валидации. Неподдержанные методы отклоняются. Переходные процессы ещё не реализованы.

## 🏗️ Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│              Frontend (Vite + React + TypeScript)            │
│   - Отрисовка схемы (SVG)                                    │
│   - Редактор схем                                            │
│   - Параметры компонентов                                    │
│   - Валидация через Rust/WASM                                │
│                        Порт 3000                             │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP/JSON
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Go API Gateway (порт 8080)                │
│  - Маршрутизация запросов                                    │
│  - Работа с PostgreSQL (схемы, компоненты, результаты)       │
│  - Проксирование на Julia compute                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                 ┌──────────────────┐
                 │  Julia Compute   │
                 │  (8001)          │
                 │  - СЛАУ          │
                 │  - Расчёт        │
                 │    режимов ЭЭС   │
                 └───────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │   PostgreSQL (5432) │
              │   - component_types │
              │   - circuit_schemes │
              │   - scheme_...      │
              │   - calculation_... │
              └─────────────────────┘


Rust/WASM — выполняется в браузере:
  - Привязка к сетке, вращение, расстояния
  - Проверка связности графа схемы
  - Валидация соединений между компонентами
```

## 📦 Сервисы

| Сервис | Технология | Порт | Описание |
|--------|------------|------|----------|
| **nginx** | nginx:alpine | 80 | Reverse proxy, rate limiting, security headers |
| **frontend** | React 18 + Vite + TypeScript + Rust/WASM | 3000 | Веб-интерфейс редактора схем |
| **go-api** | Go 1.24 + lib/pq | 8080 | API Gateway, работа с БД, проксирование |
| **julia-compute** | Julia + HTTP.jl + JSON3 | 8001 | Решение СЛАУ, расчёт режимов ЭЭС |
| **postgres** | PostgreSQL 15 | 5432 | База данных схем и результатов |

## 🚀 Быстрый старт

### Требования

- Docker ≥ 20.10
- Docker Compose ≥ 2.0

### Запуск всех сервисов

```bash
docker-compose up --build
```

После запуска:

- **Приложение**: http://localhost:80 (через nginx)
- **Frontend (dev)**: http://localhost:3000
- **Go API**: http://localhost:8080
- **PostgreSQL**: localhost:5432 (app_user / app_pass)

### Остановка

```bash
docker-compose down
```

## 📡 API

### EES API (через Go Gateway)

```bash
# Получить типы компонентов
GET http://localhost:8080/api/ees/component-types

# Получить параметры компонента
GET http://localhost:8080/api/ees/component-params/generator

# Получить список схем
GET http://localhost:8080/api/ees/schemes

# Создать схему
POST http://localhost:8080/api/ees/schemes
Content-Type: application/json
{"name": "Тестовая схема", "description": "Описание"}

# Получить схему полностью
GET http://localhost:8080/api/ees/schemes/1

# Добавить компонент
POST http://localhost:8080/api/ees/components
Content-Type: application/json
{"schemeId": 1, "typeId": 1, "x": 100, "y": 100, "rotation": 0, "name": "G1"}

# Обновить компонент
PUT http://localhost:8080/api/ees/components/1
Content-Type: application/json
{"x": 150, "y": 120, "rotation": 0, "name": "G1"}

# Сохранить параметр компонента
POST http://localhost:8080/api/ees/components/1/params
Content-Type: application/json
{"key": "voltage_nom", "value": "115.0"}

# Добавить соединение
POST http://localhost:8080/api/ees/connections
Content-Type: application/json
{"schemeId": 1, "from": 1, "to": 2, "fromPort": "port_0", "toPort": "port_1"}

# Удалить соединение
DELETE http://localhost:8080/api/ees/connections/1

# Рассчитать схему
POST http://localhost:8080/api/ees/calculate/1
```

### Legacy API (вычисления)

```bash
# Julia: решение СЛАУ
POST http://localhost:8080/julia/solve
Content-Type: application/json
{"A": [[2, 3], [1, 4]], "b": [5, 7]}

# Julia: расчёт режима ЭЭС
POST http://localhost:8080/api/ees/calculate/1
```

## 🗄️ База данных

### Таблицы

- `component_types` — типы компонентов (генератор, трансформатор, линия и т.д.)
- `component_params_template` — шаблоны параметров для каждого типа
- `circuit_schemes` — схемы (проекты)
- `scheme_components` — экземпляры компонентов в схеме
- `scheme_component_params` — параметры экземпляров
- `scheme_connections` — соединения между компонентами
- `calculation_results` — результаты расчётов
- `calculation_node_results` — результаты по узлам

### Инициализация БД

При первом запуске `docker compose up` API подготавливает пустую базу версионированными миграциями из своего образа; ими же обновляется существующая база. `database/init.sql` и `database/ees_schema.sql` остаются legacy SQL-представлениями для проверки совместимости, а не отдельным способом запуска Compose. Существующий том данных удалять не требуется. Ошибка миграции или несовместимая версия блокирует `/ready` и здоровье контейнера API.

## 🛠️ Локальная разработка

### Go API

Основной запуск — Docker/Compose. Для отдельного запуска API на host задайте `DB_HOST` и абсолютный `MIGRATIONS_SOURCE`, как описано в [CONTRIBUTING](CONTRIBUTING.md).

```bash
cd backend-go
go mod download
go run .
```

### Julia Compute (расчёт)

```bash
cd backend-julia
julia --project -e 'using Pkg; Pkg.add("HTTP"); Pkg.add("JSON3")'
julia --project main.jl
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## 🎯 Компоненты энергосистемы

| Компонент | Обозначение | Категория |
|-----------|-------------|-----------|
| Генератор | G | Источники |
| Трансформатор | TR | Трансформация |
| Линия электропередачи | L | Линии |
| Выключатель | QF | Коммутация |
| Разъединитель | QS | Коммутация |
| Нагрузка | LOAD | Нагрузка |
| Заземление | — | Шины и заземление |
| Сборная шина | — | Шины и заземление |

## 📊 Метод расчёта

**Метод узловых потенциалов** для расчёта установившихся режимов:

1. Построение модели схемы (узлы и ветви)
2. Формирование матрицы узловых проводимостей Y
3. Формирование вектора узловых токов J
4. Решение системы уравнений Y × U = J
5. Определение напряжений в узлах

### Типы узлов:

- **PQ** — узел с заданными мощностями P и Q
- **PV** — узел с заданной активной мощностью P и напряжением V
- **Slack** — балансирующий узел (задаётся напряжение и угол)

## 📁 Структура проекта

```
enersy/
├── backend-go/          # API Gateway на Go
│   ├── main.go          # Маршрутизация, БД, проксирование
│   ├── Dockerfile
│   └── go.mod
├── backend-julia/       # Вычислительный сервис на Julia
│   ├── main.jl          # СЛАУ + расчёт режимов ЭЭС
│   └── Dockerfile
├── frontend/            # React + Vite + TypeScript + Rust/WASM
│   ├── src/
│   │   ├── components/
│   │   │   └── ees/
│   │   │       ├── editor-utils.ts         # Types, constants, helpers
│   │   │       ├── hooks/
│   │   │       │   ├── useCanvasViewport.ts
│   │   │       │   ├── useSchemeData.ts
│   │   │       │   └── useCanvasInteraction.ts
│   │   │       ├── panels/
│   │   │       │   ├── LibraryPanel.tsx/.css
│   │   │       │   ├── CanvasToolbar.tsx/.css
│   │   │       │   ├── PropertiesPanel.tsx/.css
│   │   │       │   ├── ComponentParams.tsx
│   │   │       │   └── ResultsModal.tsx/.css
│   │   │       ├── SchemeEditor.tsx
│   │   │       ├── SchemeEditor.css
│   │   │       └── svg-components.tsx
│   │   ├── api/
│   │   │   └── ees-api.ts
│   │   ├── App.tsx
│   │   └── App.css
│   ├── public/
│   │   └── rust-wasm/   # Скомпилированный WASM-модуль
│   │       └── index.js
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
├── rust-wasm/           # Rust → WebAssembly утилиты
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs       # Сетка, графы, валидация соединений
├── database/            # SQL-скрипты инициализации БД
│   ├── init.sql
│   └── ees_schema.sql
├── docker-compose.yml   # Оркестрация сервисов
└── README.md
```

## 🔧 Переменные окружения

| Переменная | Сервис | Значение по умолчанию |
|------------|--------|----------------------|
| `DB_HOST` | go-api | postgres |
| `DB_PORT` | go-api | 5432 |
| `POSTGRES_DB` | postgres | app_db |
| `POSTGRES_USER` | postgres | app_user |
| `POSTGRES_PASSWORD` | postgres | app_pass |
| `PORT` | julia-compute | 8001 |

## 🎯 Возможности

- ✅ **Графический редактор схем** — визуальное моделирование энергосистем
- ✅ **Библиотека компонентов** — 8+ типов элементов ЭЭС
- ✅ **Параметризация** — настройка параметров каждого компонента
- ✅ **Хранение в БД** — PostgreSQL для схем и компонентов
- ✅ **Метод узловых потенциалов** — расчёт установившихся режимов (Julia)
- ✅ **REST API** — полный CRUD для схем и компонентов
- ✅ **Валидация через Rust/WASM** — проверка связности графа, типов соединений, привязка к сетке
- ✅ **Микросервисная архитектура** — Go, Julia, React
- ✅ **Контейнеризация** — Docker Compose для развёртывания
- ✅ **Graceful shutdown** — корректное завершение сервера (SIGINT/SIGTERM)
- ✅ **Таймауты сервера** — ReadTimeout, WriteTimeout, IdleTimeout
- ✅ **Healthcheck** — эндпоинты `/health` и `/ready` с проверкой БД
- ✅ **Валидация данных** — проверка обязательных полей во всех JSON-запросах
- ✅ **Request logging** — логирование всех запросов (method, path, status, duration)
- ✅ **Security headers** — X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy
- ✅ **Rate limiting** — 30 r/s на API, 10 r/s на /julia/, 100 r/s на frontend
- ✅ **Error handling** — ErrorBoundary, toast-уведомления вместо alert()
- ✅ **Docker layer caching** — оптимизированные Dockerfile для Go и frontend

## 📝 Лицензия

MIT
