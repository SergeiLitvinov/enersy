# Этап 1: Сборка WASM
FROM rust:1.78 AS builder

WORKDIR /app

COPY . .

# Устанавливаем wasm-pack через cargo (более стабильный способ)
RUN cargo install wasm-pack --locked

# Устанавливаем целевой компонент wasm
RUN rustup target add wasm32-unknown-unknown

# Собираем для web
RUN wasm-pack build \
    --target web \
    --out-name rust_wasm \
    --out-dir ./dist \
    --release

# Этап 2: Финальный образ
FROM alpine:latest

WORKDIR /app
COPY --from=builder /app/dist ./dist

# Держим контейнер живым
CMD ["tail", "-f", "/dev/null"]