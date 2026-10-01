//! Experimental native kernels. PCG requires a symmetric positive definite real
//! matrix. It does NOT solve the general AC Newton Jacobian or a complete network.
//! Input units and scaling belong to the caller's explicitly defined model.
pub mod csr;
pub mod pcg;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    InvalidShape,
    NonFinite,
    InvalidOptions,
    NotSymmetric,
    InvalidDiagonal,
    Breakdown,
    Cancelled,
    NotConverged { iterations: usize, residual: f64 },
}
