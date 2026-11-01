FROM golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS builder
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /app
COPY mcp-go/go.mod mcp-go/go.sum ./
RUN GODEBUG=http2client=0 go mod download
COPY mcp-go/*.go ./
RUN go build -mod=readonly -trimpath -o enersy-mcp .
COPY scripts/security/collect-go-licenses.go /tools/collect-go-licenses.go
RUN go run -mod=readonly /tools/collect-go-licenses.go /app/enersy-mcp /app/go-modules.json

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
WORKDIR /app
COPY --from=builder /app/enersy-mcp ./enersy-mcp
COPY LICENSE /usr/share/licenses/enersy/LICENSE
COPY --from=builder /app/go-modules.json /usr/share/licenses/enersy/go-modules.json
ENTRYPOINT ["/app/enersy-mcp"]
