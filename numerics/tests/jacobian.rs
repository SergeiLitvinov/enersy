use enersy_numerics::{
    jacobian::{JacobianPlan, PolarState, VoltageDemand},
    Error,
};

fn powers(
    n: usize,
    columns: &[usize],
    rows: &[usize],
    g: &[f64],
    b: &[f64],
    v: &[f64],
    theta: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let vr: Vec<_> = v.iter().zip(theta).map(|(v, t)| v * t.cos()).collect();
    let vi: Vec<_> = v.iter().zip(theta).map(|(v, t)| v * t.sin()).collect();
    let (mut ir, mut ii) = (vec![0.0; n], vec![0.0; n]);
    for k in 0..n {
        for index in columns[k]..columns[k + 1] {
            let i = rows[index];
            ir[i] += g[index] * vr[k] - b[index] * vi[k];
            ii[i] += g[index] * vi[k] + b[index] * vr[k];
        }
    }
    (
        (0..n).map(|i| vr[i] * ir[i] + vi[i] * ii[i]).collect(),
        (0..n).map(|i| vi[i] * ir[i] - vr[i] * ii[i]).collect(),
    )
}

#[test]
fn analytical_resistive_two_bus_and_singleton() {
    // Y=[[1,-1],[-1,1]], V=[1,0.8], theta=0; PQ J=[[0,0.6],[-0.8,0]].
    let plan = JacobianPlan::new(2, 0, &[], &[1], &[0, 2, 4], &[0, 1, 0, 1]).unwrap();
    let mut values = vec![0.0; plan.row_indices().len()];
    plan.update(
        &[1.0, -1.0, -1.0, 1.0],
        &[0.0; 4],
        PolarState {
            voltage: &[1.0, 0.8],
            angle: &[0.0, 0.0],
            p: &[0.2, -0.16],
            q: &[0.0, 0.0],
        },
        &[],
        &mut values,
    )
    .unwrap();
    // Columns are angle, voltage; rows are P, Q (so off-diagonal entries).
    assert_eq!(plan.column_offsets(), &[0, 2, 4]);
    for (actual, expected) in values.iter().zip([0.0, -0.8, 0.6, 0.0]) {
        assert!((actual - expected).abs() < 1e-12);
    }
    let singleton = JacobianPlan::new(1, 0, &[], &[], &[0, 0], &[]).unwrap();
    assert_eq!(singleton.dimension(), 0);
    assert!(singleton
        .update(
            &[],
            &[],
            PolarState {
                voltage: &[1.0],
                angle: &[0.0],
                p: &[0.0],
                q: &[0.0]
            },
            &[],
            &mut []
        )
        .is_ok());
}

#[test]
fn finite_differences_cover_nonsymmetric_y_missing_diagonal_pv_zip_and_ordering() {
    // Arbitrary nonsymmetric complex coupling (e.g. a phase-shifting tap).
    // The PQ diagonal is absent; P/Q still contribute to the Jacobian.
    let columns = [0, 2, 4, 7];
    let rows = [1, 2, 0, 2, 0, 1, 2];
    let g = [-0.3, -0.7, -0.8, -0.5, -0.4, -0.9, 1.8];
    let b = [1.1, 2.3, 1.5, 2.0, 2.7, 0.8, -4.0];
    let demands = [
        VoltageDemand {
            bus: 0,
            p_i: 0.2,
            p_z: 0.3,
            q_i: -0.05,
            q_z: 0.1,
        },
        VoltageDemand {
            bus: 0,
            p_i: 0.1,
            p_z: 0.2,
            q_i: 0.04,
            q_z: 0.2,
        },
    ];
    let pv = [2];
    let pq = [0];
    let order = [2, 0];
    let plan = JacobianPlan::new(3, 1, &pv, &pq, &columns, &rows).unwrap();
    let residual = |v: &[f64], theta: &[f64]| {
        let (p, q) = powers(3, &columns, &rows, &g, &b, v, theta);
        vec![
            p[2],
            p[0] + demands
                .iter()
                .map(|d| d.p_i * v[0] + d.p_z * v[0] * v[0])
                .sum::<f64>(),
            q[0] + demands
                .iter()
                .map(|d| d.q_i * v[0] + d.q_z * v[0] * v[0])
                .sum::<f64>(),
            v[2] * v[2],
        ]
    };
    let pattern_ptr = plan.row_indices().as_ptr();
    let mut values = vec![0.0; plan.row_indices().len()];
    let output_ptr = values.as_ptr();
    for (v, theta) in [
        ([0.97, 1.03, 1.01], [-0.11, 0.03, 0.09]),
        ([1.1, 0.99, 0.93], [0.2, -0.1, -0.17]),
    ] {
        let (p, q) = powers(3, &columns, &rows, &g, &b, &v, &theta);
        plan.update(
            &g,
            &b,
            PolarState {
                voltage: &v,
                angle: &theta,
                p: &p,
                q: &q,
            },
            &demands,
            &mut values,
        )
        .unwrap();
        assert_eq!(plan.row_indices().as_ptr(), pattern_ptr);
        assert_eq!(values.as_ptr(), output_ptr);
        let h = 1e-6;
        for col in 0..4 {
            let (mut vp, mut vm, mut tp, mut tm) = (v, v, theta, theta);
            if col < 2 {
                tp[order[col]] += h;
                tm[order[col]] -= h;
            } else {
                vp[order[col - 2]] += h;
                vm[order[col - 2]] -= h;
            }
            let (plus, minus) = (residual(&vp, &tp), residual(&vm, &tm));
            for row in 0..4 {
                let range = plan.column_offsets()[col]..plan.column_offsets()[col + 1];
                let actual = range
                    .into_iter()
                    .find(|&k| plan.row_indices()[k] == row)
                    .map(|k| values[k])
                    .unwrap_or(0.0);
                assert!(
                    (actual - (plus[row] - minus[row]) / (2.0 * h)).abs() < 5e-7,
                    "row={row} column={col}"
                );
            }
        }
    }
}

#[test]
fn rejects_bad_patterns_state_and_demand_bindings() {
    for (n, slack, pv, pq, cols, rows) in [
        (2, 0, vec![], vec![0], vec![0, 0, 0], vec![]),
        (3, 0, vec![1], vec![1], vec![0, 0, 0, 0], vec![]),
        (2, 0, vec![], vec![1], vec![0, 2, 1], vec![0]),
        (2, 0, vec![], vec![1], vec![0, 2, 2], vec![1, 0]),
        (2, 0, vec![], vec![1], vec![0, 2, 2], vec![0, 0]),
        (2, 0, vec![], vec![1], vec![0, 1, 1], vec![2]),
    ] {
        assert!(matches!(
            JacobianPlan::new(n, slack, &pv, &pq, &cols, &rows),
            Err(Error::InvalidShape)
        ));
    }
    let plan = JacobianPlan::new(2, 0, &[], &[1], &[0, 2, 4], &[0, 1, 0, 1]).unwrap();
    let mut output = vec![0.0; plan.row_indices().len()];
    for (voltage, expected) in [
        ([1.0, 0.0], Error::InvalidVoltage),
        ([1.0, f64::NAN], Error::NonFinite),
    ] {
        assert_eq!(
            plan.update(
                &[1.0; 4],
                &[0.0; 4],
                PolarState {
                    voltage: &voltage,
                    angle: &[0.0; 2],
                    p: &[0.0; 2],
                    q: &[0.0; 2]
                },
                &[],
                &mut output
            ),
            Err(expected)
        );
    }
    let bad = VoltageDemand {
        bus: 0,
        p_i: 0.0,
        p_z: 0.0,
        q_i: 0.0,
        q_z: 0.0,
    };
    assert_eq!(
        plan.update(
            &[1.0; 4],
            &[0.0; 4],
            PolarState {
                voltage: &[1.0; 2],
                angle: &[0.0; 2],
                p: &[0.0; 2],
                q: &[0.0; 2]
            },
            &[bad],
            &mut output
        ),
        Err(Error::InvalidShape)
    );
    assert_eq!(
        plan.update(
            &[f64::MAX; 4],
            &[0.0; 4],
            PolarState {
                voltage: &[2.0; 2],
                angle: &[0.0; 2],
                p: &[f64::MAX; 2],
                q: &[0.0; 2]
            },
            &[],
            &mut output
        ),
        Err(Error::NonFinite)
    );
}
