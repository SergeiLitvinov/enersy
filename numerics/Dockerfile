FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8
RUN rustup component add clippy rustfmt
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
COPY examples ./examples
CMD ["sh", "-c", "rustc --version && cargo fmt --check && cargo test --all-features --locked --offline --target-dir /tmp/target && cargo clippy --all-features --locked --offline --target-dir /tmp/target --all-targets -- -D warnings"]
