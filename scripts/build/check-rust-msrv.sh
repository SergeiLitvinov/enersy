#!/bin/sh
set -eu

# The minimum compiler is tested separately from the release SDK and its lints.
rustc --version
cargo --version
test "$(rustc --version | cut -d ' ' -f 2)" = '1.85.0'
test "$(cargo --version | cut -d ' ' -f 2)" = '1.85.0'
for manifest in numerics/Cargo.toml rust-wasm/Cargo.toml; do
    grep -Eq '^[[:space:]]*rust-version[[:space:]]*=[[:space:]]*"1\.85(\.0)?"[[:space:]]*$' "$manifest"
done

# --locked/--offline prevent dependency changes and downloads during testing.
# Hash both manifests and locks to detect unexpected writes even in the image.
sha256sum numerics/Cargo.toml numerics/Cargo.lock rust-wasm/Cargo.toml rust-wasm/Cargo.lock > /tmp/msrv-inputs.sha256
export CARGO_TARGET_DIR=/tmp/msrv-target
cargo test --manifest-path numerics/Cargo.toml --locked --offline --all-targets
cargo test --manifest-path numerics/Cargo.toml --locked --offline --all-features --all-targets
cargo build --manifest-path numerics/Cargo.toml --release --locked --offline --all-features
test -s "$CARGO_TARGET_DIR/release/libenersy_numerics.so"
cargo test --manifest-path rust-wasm/Cargo.toml --locked --offline --all-targets
cargo build --manifest-path rust-wasm/Cargo.toml --release --locked --offline --target wasm32-unknown-unknown
test -s "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/rust_wasm.wasm"
sha256sum --check /tmp/msrv-inputs.sha256
