FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY examples ./examples
RUN cargo build --release --locked --offline --example jacobian_probe
ENTRYPOINT ["/workspace/target/release/examples/jacobian_probe"]
