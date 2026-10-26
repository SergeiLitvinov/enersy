#!/bin/sh
set -eu

# Run inside the Rust build stage, after producing the artifact.
artifact="$1"
target="$2"
features="${3-}"
output=/notice-inputs
mkdir -p "$output/project" "$output/vendor" "$output/toolchain/licenses"
sha256sum Cargo.toml Cargo.lock > /tmp/rust-notice-inputs.sha256
if [ -n "$features" ]; then
    cargo metadata --locked --offline --format-version 1 --features "$features" > "$output/metadata.json"
else
    cargo metadata --locked --offline --format-version 1 > "$output/metadata.json"
fi
cargo vendor --locked --offline --versioned-dirs "$output/vendor" > "$output/vendor-config.toml"
cp Cargo.toml Cargo.lock LICENSE "$output/project/"
cp "$artifact" "$output/artifact"
basename "$artifact" > "$output/artifact-name.txt"
rustc --version --verbose > "$output/compiler.txt"
if [ "$target" = native ]; then
    target="$(sed -n 's/^host: //p' "$output/compiler.txt")"
fi
printf '%s\n' "$target" > "$output/target.txt"
rust_docs="$(rustc --print sysroot)/share/doc/rust"
cp "$rust_docs/COPYRIGHT-library.html" "$output/toolchain/"
cp "$rust_docs"/licenses/*.txt "$output/toolchain/licenses/"
sha256sum --check /tmp/rust-notice-inputs.sha256
