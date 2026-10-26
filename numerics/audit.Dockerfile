FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8
RUN cargo install cargo-audit --version 0.22.2 --locked
WORKDIR /audit
CMD ["sh", "-c", "cargo audit --version && cargo audit --file /locks/numerics.lock --deny warnings && cargo audit --file /locks/wasm.lock --deny warnings"]
