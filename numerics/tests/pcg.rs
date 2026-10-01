use enersy_numerics::{
    csr::CsrMatrix,
    pcg::{solve, Options},
    Error,
};
fn options() -> Options {
    Options {
        absolute_tolerance: 1e-10,
        relative_tolerance: 1e-10,
        max_iterations: 100,
    }
}
fn matrix() -> CsrMatrix {
    CsrMatrix::new(
        2,
        vec![0, 2, 4],
        vec![0, 1, 0, 1],
        vec![2.0, -1.0, -1.0, 2.0],
    )
    .unwrap()
}

#[test]
fn resistive_network_kirchhoff_and_power() {
    // Two unknown voltages, each grounded through 1 ohm, connected by 1 ohm.
    // Inject 1 A at bus 1: 2V1-V2=1, -V1+2V2=0; V=[2/3,1/3] V.
    let result = solve(&matrix(), &[1.0, 0.0], &options(), |_| true).unwrap();
    let (v1, v2) = (result.values[0], result.values[1]);
    assert!((v1 - 2.0 / 3.0).abs() < 1e-10 && (v2 - 1.0 / 3.0).abs() < 1e-10);
    let dissipated = v1 * v1 + v2 * v2 + (v1 - v2).powi(2); // watts, all resistances 1 ohm
    assert!((v1 - dissipated).abs() < 1e-10);
    assert!(result.residual < 1e-10);
}
#[test]
fn sparse_large_chain() {
    let n = 1000;
    let (mut rows, mut columns, mut values) = (vec![0], vec![], vec![]);
    for i in 0..n {
        if i > 0 {
            columns.push(i - 1);
            values.push(-1.0);
        }
        columns.push(i);
        values.push(3.0);
        if i + 1 < n {
            columns.push(i + 1);
            values.push(-1.0);
        }
        rows.push(values.len());
    }
    let a = CsrMatrix::new(n, rows, columns, values).unwrap();
    assert_eq!(a.nonzeros(), 3 * n - 2);
    let mut rhs = vec![1.0; n];
    rhs[0] = 2.0;
    rhs[n - 1] = 2.0;
    let result = solve(&a, &rhs, &options(), |_| true).unwrap();
    assert!(result.values.iter().all(|v| (v - 1.0).abs() < 1e-8));
}
#[test]
fn cancellation_and_no_false_convergence() {
    assert!(matches!(
        solve(&matrix(), &[1.0, 0.0], &options(), |_| false),
        Err(Error::Cancelled)
    ));
    let limited = Options {
        max_iterations: 1,
        ..options()
    };
    assert!(matches!(
        solve(&matrix(), &[1.0, 0.0], &limited, |_| true),
        Err(Error::NotConverged { .. })
    ));
}
#[test]
fn rejects_invalid_data_and_wrong_solver_family() {
    assert!(CsrMatrix::new(1, vec![0, 2], vec![0], vec![1.0]).is_err());
    assert!(CsrMatrix::new(1, vec![0, 1], vec![0], vec![f64::NAN]).is_err());
    assert!(matches!(
        solve(&matrix(), &[f64::INFINITY, 0.0], &options(), |_| true),
        Err(Error::NonFinite)
    ));
    let asymmetric = CsrMatrix::new(2, vec![0, 2, 3], vec![0, 1, 1], vec![1.0, 1.0, 1.0]).unwrap();
    assert!(matches!(
        solve(&asymmetric, &[1.0, 1.0], &options(), |_| true),
        Err(Error::NotSymmetric)
    ));
    let indefinite =
        CsrMatrix::new(2, vec![0, 2, 4], vec![0, 1, 0, 1], vec![1.0, 2.0, 2.0, 1.0]).unwrap();
    assert!(matches!(
        solve(&indefinite, &[1.0, -1.0], &options(), |_| true),
        Err(Error::Breakdown)
    ));
}
#[test]
fn zero_rhs() {
    assert_eq!(
        solve(&matrix(), &[0.0, 0.0], &options(), |_| true)
            .unwrap()
            .iterations,
        0
    );
}
