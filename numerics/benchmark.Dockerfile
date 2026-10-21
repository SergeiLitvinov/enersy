FROM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY examples ./examples
RUN cargo build --release --locked --offline --example jacobian_probe
ENTRYPOINT ["/workspace/target/release/examples/jacobian_probe"]
