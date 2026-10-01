use crate::{csr::CsrMatrix, Error};

pub struct Options {
    pub absolute_tolerance: f64,
    pub relative_tolerance: f64,
    pub max_iterations: usize,
}
#[derive(Debug)]
pub struct Solution {
    pub values: Vec<f64>,
    pub iterations: usize,
    pub residual: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Progress {
    pub iteration: usize,
    pub residual: f64,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
fn norm(a: &[f64]) -> f64 {
    a.iter().fold(0.0_f64, |v, x| v.hypot(*x))
}

/// Jacobi-preconditioned CG with explicit options, progress/cancellation and
/// true residual verification. O(nnz) multiplication and O(n) work storage.
/// Symmetry is checked; SPD is caller's mathematical precondition. Nonpositive
/// curvature is diagnosed, but this is not a general-purpose SPD certification.
pub fn solve(
    matrix: &CsrMatrix,
    rhs: &[f64],
    options: &Options,
    mut continue_run: impl FnMut(Progress) -> bool,
) -> Result<Solution, Error> {
    let n = matrix.dimension();
    if rhs.len() != n {
        return Err(Error::InvalidShape);
    }
    if rhs.iter().any(|x| !x.is_finite()) {
        return Err(Error::NonFinite);
    }
    if !options.absolute_tolerance.is_finite()
        || !options.relative_tolerance.is_finite()
        || options.absolute_tolerance < 0.0
        || options.relative_tolerance < 0.0
        || (options.absolute_tolerance == 0.0 && options.relative_tolerance == 0.0)
        || options.max_iterations == 0
    {
        return Err(Error::InvalidOptions);
    }
    matrix.check_symmetry()?;
    let inverse_diagonal = (0..n)
        .map(|i| {
            let d = matrix.entry(i, i).ok_or(Error::InvalidDiagonal)?;
            let inverse = 1.0 / d;
            if d <= 0.0 || !inverse.is_finite() {
                Err(Error::InvalidDiagonal)
            } else {
                Ok(inverse)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut x = vec![0.0; n];
    let mut r = rhs.to_vec();
    let mut z: Vec<_> = r
        .iter()
        .zip(&inverse_diagonal)
        .map(|(r, d)| r * d)
        .collect();
    let mut p = z.clone();
    let mut ap = vec![0.0; n];
    let target = options
        .absolute_tolerance
        .max(options.relative_tolerance * norm(rhs));
    if !target.is_finite() {
        return Err(Error::NonFinite);
    }
    let mut rho = dot(&r, &z);
    for iteration in 0..=options.max_iterations {
        let residual = norm(&r);
        if !residual.is_finite() {
            return Err(Error::NonFinite);
        }
        if !continue_run(Progress {
            iteration,
            residual,
        }) {
            return Err(Error::Cancelled);
        }
        if residual <= target {
            matrix.multiply(&x, &mut ap)?;
            for i in 0..n {
                r[i] = rhs[i] - ap[i];
            }
            let actual = norm(&r);
            if actual <= target {
                return Ok(Solution {
                    values: x,
                    iterations: iteration,
                    residual: actual,
                });
            }
            // Restart on verified residual; never accept only the recurrence.
            for i in 0..n {
                z[i] = r[i] * inverse_diagonal[i];
                p[i] = z[i];
            }
            rho = dot(&r, &z);
        }
        if iteration == options.max_iterations {
            break;
        }
        matrix.multiply(&p, &mut ap)?;
        let curvature = dot(&p, &ap);
        if !rho.is_finite() || !curvature.is_finite() {
            return Err(Error::NonFinite);
        }
        if rho <= 0.0 || curvature <= 0.0 {
            return Err(Error::Breakdown);
        }
        let alpha = rho / curvature;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
            z[i] = r[i] * inverse_diagonal[i];
        }
        let next = dot(&r, &z);
        let beta = next / rho;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        rho = next;
    }
    matrix.multiply(&x, &mut ap)?;
    for i in 0..n {
        r[i] = rhs[i] - ap[i];
    }
    Err(Error::NotConverged {
        iterations: options.max_iterations,
        residual: norm(&r),
    })
}
