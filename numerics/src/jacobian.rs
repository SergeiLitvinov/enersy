//! Experimental polar AC Jacobian, J = -d(mismatch)/dx, in p.u.; angles in rad.
//! Same augmented PV convention as Enersy: P(PV/PQ), Q(PQ), |V|²(PV).
//! Pattern planning is separate from allocation-free value updates. No solver,
//! physical model selection, topology inference, FFI or browser binding here.
use crate::Error;

const NONE: usize = usize::MAX;

#[derive(Clone, Copy)]
pub struct VoltageDemand {
    pub bus: usize,
    pub p_i: f64,
    pub p_z: f64,
    pub q_i: f64,
    pub q_z: f64,
}

pub struct PolarState<'a> {
    pub voltage: &'a [f64],
    pub angle: &'a [f64],
    pub p: &'a [f64],
    pub q: &'a [f64],
}

struct Coupling {
    row: usize,
    column: usize,
    y: usize,
    slots: [usize; 4],
}
struct Diagonal {
    bus: usize,
    y: usize,
    slots: [usize; 5],
}

/// Immutable plan bound to one canonical CSC Y pattern and exact bus ordering.
/// Rebuild after changing topology, PV/PQ classification or bus order. Numeric
/// admittances may change only in that original CSC order. Structural zeros are
/// retained intentionally; this enables repeated updates without re-sorting.
pub struct JacobianPlan {
    n: usize,
    y_nonzeros: usize,
    dimension: usize,
    columns: Vec<usize>,
    rows: Vec<usize>,
    couplings: Vec<Coupling>,
    diagonals: Vec<Diagonal>,
    pq_voltage_slots: Vec<Option<(usize, usize)>>,
}

impl JacobianPlan {
    pub fn new(
        n: usize,
        slack: usize,
        pv: &[usize],
        pq: &[usize],
        y_columns: &[usize],
        y_rows: &[usize],
    ) -> Result<Self, Error> {
        if n == 0
            || slack >= n
            || pv.len().checked_add(pq.len()) != Some(n - 1)
            || y_columns.len() != n.checked_add(1).ok_or(Error::InvalidShape)?
            || y_columns[0] != 0
            || y_columns[n] != y_rows.len()
        {
            return Err(Error::InvalidShape);
        }
        for bounds in y_columns.windows(2) {
            let (a, b) = (bounds[0], bounds[1]);
            if a > b
                || b > y_rows.len()
                || y_rows[a..b].iter().any(|&i| i >= n)
                || y_rows[a..b].windows(2).any(|pair| pair[0] >= pair[1])
            {
                return Err(Error::InvalidShape);
            }
        }
        let dimension = (n - 1).checked_mul(2).ok_or(Error::InvalidShape)?;
        let (mut ct, mut cv, mut rp, mut rq, mut rv) = (
            vec![NONE; n],
            vec![NONE; n],
            vec![NONE; n],
            vec![NONE; n],
            vec![NONE; n],
        );
        for (k, &bus) in pv.iter().chain(pq).enumerate() {
            if bus >= n || bus == slack || ct[bus] != NONE {
                return Err(Error::InvalidShape);
            }
            ct[bus] = k;
            cv[bus] = n - 1 + k;
            rp[bus] = k;
        }
        for (k, &bus) in pq.iter().enumerate() {
            rq[bus] = n - 1 + k;
        }
        for (k, &bus) in pv.iter().enumerate() {
            rv[bus] = n - 1 + pq.len() + k;
        }
        let mut by_column = vec![Vec::new(); dimension];
        let mut add = |row: usize, column: usize| {
            if row != NONE {
                by_column[column].push(row);
            }
        };
        let mut couplings = Vec::new();
        let mut y_diagonal = vec![NONE; n];
        for k in 0..n {
            for (index, &i) in y_rows
                .iter()
                .enumerate()
                .take(y_columns[k + 1])
                .skip(y_columns[k])
            {
                if i == k {
                    y_diagonal[i] = index;
                    continue;
                }
                if i == slack || k == slack {
                    continue;
                }
                add(rp[i], ct[k]);
                add(rp[i], cv[k]);
                add(rq[i], ct[k]);
                add(rq[i], cv[k]);
                couplings.push(Coupling {
                    row: i,
                    column: k,
                    y: index,
                    slots: [NONE; 4],
                });
            }
        }
        for &i in pv.iter().chain(pq) {
            add(rp[i], ct[i]);
            add(rp[i], cv[i]);
            add(rq[i], ct[i]);
            add(rq[i], cv[i]);
            add(rv[i], cv[i]);
        }
        let (mut columns, mut rows) = (vec![0], Vec::new());
        for column in &mut by_column {
            column.sort_unstable();
            column.dedup();
            rows.extend_from_slice(column);
            columns.push(rows.len());
        }
        let slot = |row, col| {
            if row == NONE {
                NONE
            } else {
                columns[col]
                    + rows[columns[col]..columns[col + 1]]
                        .binary_search(&row)
                        .expect("planned entry")
            }
        };
        for c in &mut couplings {
            let (i, k) = (c.row, c.column);
            c.slots = [
                slot(rp[i], ct[k]),
                slot(rp[i], cv[k]),
                slot(rq[i], ct[k]),
                slot(rq[i], cv[k]),
            ];
        }
        let mut diagonals = Vec::with_capacity(n - 1);
        let mut pq_voltage_slots = vec![None; n];
        for &i in pv.iter().chain(pq) {
            let slots = [
                slot(rp[i], ct[i]),
                slot(rp[i], cv[i]),
                slot(rq[i], ct[i]),
                slot(rq[i], cv[i]),
                slot(rv[i], cv[i]),
            ];
            if rq[i] != NONE {
                pq_voltage_slots[i] = Some((slots[1], slots[3]));
            }
            diagonals.push(Diagonal {
                bus: i,
                y: y_diagonal[i],
                slots,
            });
        }
        Ok(Self {
            n,
            y_nonzeros: y_rows.len(),
            dimension,
            columns,
            rows,
            couplings,
            diagonals,
            pq_voltage_slots,
        })
    }

    pub fn dimension(&self) -> usize {
        self.dimension
    }
    pub fn column_offsets(&self) -> &[usize] {
        &self.columns
    }
    pub fn row_indices(&self) -> &[usize] {
        &self.rows
    }

    /// Fill caller-owned CSC values, with no heap allocations. p/q must be the
    /// calculated bus powers at this state, not specified injections. Multiple
    /// co-located ZIP demands are summed. On error discard the output buffer.
    pub fn update(
        &self,
        g: &[f64],
        b: &[f64],
        state: PolarState<'_>,
        demands: &[VoltageDemand],
        output: &mut [f64],
    ) -> Result<(), Error> {
        let (v, theta, p, q) = (state.voltage, state.angle, state.p, state.q);
        if g.len() != self.y_nonzeros
            || b.len() != self.y_nonzeros
            || output.len() != self.rows.len()
            || [v, theta, p, q].iter().any(|a| a.len() != self.n)
        {
            return Err(Error::InvalidShape);
        }
        if [g, b, v, theta, p, q]
            .iter()
            .any(|a| a.iter().any(|x| !x.is_finite()))
        {
            return Err(Error::NonFinite);
        }
        if v.iter().any(|&x| x <= 0.0) {
            return Err(Error::InvalidVoltage);
        }
        for d in demands {
            if d.bus >= self.n || self.pq_voltage_slots[d.bus].is_none() {
                return Err(Error::InvalidShape);
            }
            if [d.p_i, d.p_z, d.q_i, d.q_z].iter().any(|x| !x.is_finite()) {
                return Err(Error::NonFinite);
            }
        }
        output.fill(0.0);
        for c in &self.couplings {
            let (i, k) = (c.row, c.column);
            let (sn, cs) = (theta[i] - theta[k]).sin_cos();
            let a = g[c.y] * sn - b[c.y] * cs;
            let z = g[c.y] * cs + b[c.y] * sn;
            for (slot, value) in
                c.slots
                    .into_iter()
                    .zip([v[i] * v[k] * a, v[i] * z, -v[i] * v[k] * z, v[i] * a])
            {
                if slot != NONE {
                    output[slot] = value;
                }
            }
        }
        for d in &self.diagonals {
            let i = d.bus;
            let (g, b) = if d.y == NONE {
                (0.0, 0.0)
            } else {
                (g[d.y], b[d.y])
            };
            for (slot, value) in d.slots.into_iter().zip([
                -q[i] - v[i] * v[i] * b,
                v[i] * g + p[i] / v[i],
                p[i] - v[i] * v[i] * g,
                q[i] / v[i] - v[i] * b,
                2.0 * v[i],
            ]) {
                if slot != NONE {
                    output[slot] = value;
                }
            }
        }
        for d in demands {
            let (ps, qs) = self.pq_voltage_slots[d.bus].expect("validated PQ demand");
            output[ps] += d.p_i + 2.0 * d.p_z * v[d.bus];
            output[qs] += d.q_i + 2.0 * d.q_z * v[d.bus];
        }
        if output.iter().any(|x| !x.is_finite()) {
            return Err(Error::NonFinite);
        }
        Ok(())
    }
}
