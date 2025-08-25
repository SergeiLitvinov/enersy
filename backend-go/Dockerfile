# backend-go/Dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Копируем модульные файлы
COPY go.mod .

# Скачиваем зависимости
RUN go mod download

# Копируем код
COPY main.go .

# Сборка
RUN go build -o server .

# Финальный образ
FROM alpine:latest

# Установка сертификатов
RUN apk --no-cache add ca-certificates

# Рабочая директория
WORKDIR /app

# Копируем сервер из билдера
COPY --from=builder /app/server .

# Открываем порт
EXPOSE 8080

# Запуск
CMD ["./server"]