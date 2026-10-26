FROM rust:1.85.0-bookworm@sha256:0ff31c9ffa641a62e48d543fb00b4960955ea375f40776f40f585b89e654cc5e
RUN rustup target add wasm32-unknown-unknown
WORKDIR /workspace
COPY numerics/Cargo.toml numerics/Cargo.lock ./numerics/
COPY numerics/src ./numerics/src
COPY numerics/tests ./numerics/tests
COPY numerics/examples ./numerics/examples
COPY rust-wasm/Cargo.toml rust-wasm/Cargo.lock ./rust-wasm/
COPY rust-wasm/src ./rust-wasm/src
RUN cargo fetch --locked --manifest-path numerics/Cargo.toml \
    && cargo fetch --locked --manifest-path rust-wasm/Cargo.toml
COPY scripts/build/check-rust-msrv.sh /usr/local/bin/check-rust-msrv
CMD ["sh", "/usr/local/bin/check-rust-msrv"]
