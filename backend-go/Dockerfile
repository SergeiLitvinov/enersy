FROM golang:1.24-alpine AS builder

WORKDIR /app

COPY backend-go/go.mod backend-go/go.sum ./
RUN go mod download

COPY backend-go/*.go ./
ARG VERSION=dev
ARG COMMIT=none
ARG BUILDTIME=unknown
RUN go build -ldflags="-X main.Version=${VERSION} -X main.Commit=${COMMIT} -X main.BuildTime=${BUILDTIME}" -o server .

FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/server .
COPY database/migrations ./database/migrations

EXPOSE 8080

CMD ["./server"]
