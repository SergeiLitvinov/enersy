ARG JULIA_COMPUTE_IMAGE=enersy-julia-compute
FROM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4 AS native
WORKDIR /build
COPY numerics/Cargo.toml numerics/Cargo.lock ./
COPY numerics/src ./src
COPY numerics/tests/fixtures ./fixtures
COPY numerics/include ./include
RUN cargo build --release --locked --offline --features c-abi && \
    rustc --crate-type cdylib --edition 2021 fixtures/wrong_abi.rs -o /build/libwrong_abi.so && \
    cc -std=c11 -Iinclude -fsyntax-only fixtures/header_layout.c

FROM ${JULIA_COMPUTE_IMAGE}
COPY --from=native /build/target/release/libenersy_numerics.so /opt/enersy/libenersy_numerics.so
COPY --from=native /build/libwrong_abi.so /opt/enersy/libwrong_abi.so
COPY backend-julia/experimental ./experimental
COPY backend-julia/test/rust_ffi.jl ./test/rust_ffi.jl
CMD ["julia", "--project=.", "--startup-file=no", "test/rust_ffi.jl"]
