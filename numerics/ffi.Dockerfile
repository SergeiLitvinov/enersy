ARG JULIA_COMPUTE_IMAGE=enersy-julia-compute
FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS native
WORKDIR /build
COPY numerics/Cargo.toml numerics/Cargo.lock ./
COPY numerics/src ./src
COPY numerics/tests/fixtures ./fixtures
COPY numerics/include ./include
RUN cargo build --release --locked --offline --features c-abi && \
    rustc --crate-type cdylib --edition 2021 fixtures/wrong_abi.rs -o /build/libwrong_abi.so && \
    cc -std=c11 -Iinclude -fsyntax-only fixtures/header_layout.c
COPY LICENSE ./LICENSE
COPY scripts/build/prepare-rust-notices.sh /tools/prepare-rust-notices.sh
RUN sh /tools/prepare-rust-notices.sh /build/target/release/libenersy_numerics.so native c-abi

FROM node:24-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS notices
COPY --from=native /notice-inputs /inputs
COPY scripts/security/collect-rust-licenses.mjs /tools/collect-rust-licenses.mjs
RUN node /tools/collect-rust-licenses.mjs /inputs /rust-native.json

FROM ${JULIA_COMPUTE_IMAGE}
COPY --from=native /build/target/release/libenersy_numerics.so /opt/enersy/libenersy_numerics.so
COPY --from=native /build/libwrong_abi.so /opt/enersy/libwrong_abi.so
COPY --from=notices /rust-native.json /usr/share/licenses/enersy/rust-native.json
COPY --from=native /notice-inputs/toolchain /usr/share/licenses/enersy/rust-stdlib
COPY backend-julia/experimental ./experimental
COPY backend-julia/test/rust_ffi.jl ./test/rust_ffi.jl
COPY backend-julia/test/native_http.jl ./test/native_http.jl
COPY backend-julia/test/native_execution.jl ./test/native_execution.jl
CMD ["julia", "--project=.", "--startup-file=no", "test/rust_ffi.jl"]
