FROM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4
RUN rustup component add clippy rustfmt
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
CMD ["sh", "-c", "cargo test --locked --offline --target-dir /tmp/target && cargo clippy --locked --offline --target-dir /tmp/target --all-targets -- -D warnings"]
