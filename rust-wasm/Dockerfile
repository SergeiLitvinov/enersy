FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS build
RUN rustup component add clippy rustfmt && rustup target add wasm32-unknown-unknown
WORKDIR /workspace
COPY rust-wasm/Cargo.toml rust-wasm/Cargo.lock ./
COPY rust-wasm/src ./src
RUN cargo fetch --locked
RUN cargo build --release --locked --offline --target wasm32-unknown-unknown
COPY LICENSE ./LICENSE
COPY scripts/build/prepare-rust-notices.sh /tools/prepare-rust-notices.sh
RUN sh /tools/prepare-rust-notices.sh /workspace/target/wasm32-unknown-unknown/release/rust_wasm.wasm wasm32-unknown-unknown

FROM node:24-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS notices
COPY --from=build /notice-inputs /inputs
COPY scripts/security/collect-rust-licenses.mjs /tools/collect-rust-licenses.mjs
RUN node /tools/collect-rust-licenses.mjs /inputs /rust-wasm.json

FROM build
COPY --from=notices /rust-wasm.json /usr/share/licenses/enersy/rust-wasm.json
COPY --from=build /notice-inputs/toolchain /usr/share/licenses/enersy/rust-stdlib
COPY LICENSE /usr/share/licenses/enersy/LICENSE
CMD ["sh", "-c", "rustc --version && cargo fmt --check && cargo test --locked --offline --target-dir /tmp/target && cargo build --release --locked --offline --target wasm32-unknown-unknown --target-dir /tmp/target && test -s /tmp/target/wasm32-unknown-unknown/release/rust_wasm.wasm && cargo clippy --locked --offline --all-targets --target-dir /tmp/target -- -D warnings"]
