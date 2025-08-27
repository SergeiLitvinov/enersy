# Этап 1: Сборка WASM
FROM rust:1.78 AS wasm-builder

WORKDIR /app

# Копируем папку rust-wasm из корня проекта
COPY ../rust-wasm ./rust-wasm

# Входим в папку rust-wasm
WORKDIR /app/rust-wasm

# Устанавливаем wasm-pack
RUN cargo install wasm-pack --locked

# Добавляем target
RUN rustup target add wasm32-unknown-unknown

# Собираем WASM для web
RUN wasm-pack build \
    --target web \
    --out-name rust_wasm \
    --out-dir ../dist \
    --release

# Этап 2: Фронтенд
FROM node:18-alpine AS frontend

WORKDIR /app

# 🔥 Копируем WASM-файлы из dist в public/rust-wasm
COPY --from=wasm-builder /app/dist /app/public/rust-wasm

# Копируем index.js (если он есть)
COPY ./frontend/public/rust-wasm/index.js /app/public/rust-wasm/index.js

# Копируем package.json и устанавливаем зависимости
COPY ./frontend/package.json ./
RUN npm install

# Копируем остальные исходники
COPY ./frontend/src ./src
COPY ./frontend/index.html ./
COPY ./frontend/vite.config.ts ./

# Публикуем порт
EXPOSE 3000

# Запускаем Vite
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3000"]