use crate::Error;

/// Canonical square CSR: sorted unique columns, immutable storage, no dense copy.
pub struct CsrMatrix {
    n: usize,
    rows: Vec<usize>,
    columns: Vec<usize>,
    values: Vec<f64>,
}

impl CsrMatrix {
    pub fn new(
        n: usize,
        rows: Vec<usize>,
        columns: Vec<usize>,
        values: Vec<f64>,
    ) -> Result<Self, Error> {
        if n == 0
            || rows.len() != n.checked_add(1).ok_or(Error::InvalidShape)?
            || columns.len() != values.len()
            || rows[0] != 0
            || rows[n] != values.len()
        {
            return Err(Error::InvalidShape);
        }
        if values.iter().any(|v| !v.is_finite()) {
            return Err(Error::NonFinite);
        }
        for range in rows.windows(2) {
            let (a, b) = (range[0], range[1]);
            if a > b
                || b > values.len()
                || columns[a..b].iter().any(|&c| c >= n)
                || columns[a..b].windows(2).any(|c| c[0] >= c[1])
            {
                return Err(Error::InvalidShape);
            }
        }
        Ok(Self {
            n,
            rows,
            columns,
            values,
        })
    }
    pub fn dimension(&self) -> usize {
        self.n
    }
    pub fn nonzeros(&self) -> usize {
        self.values.len()
    }
    pub fn entry(&self, row: usize, column: usize) -> Option<f64> {
        if row >= self.n || column >= self.n {
            return None;
        }
        let start = self.rows[row];
        self.columns[start..self.rows[row + 1]]
            .binary_search(&column)
            .ok()
            .map(|i| self.values[start + i])
    }
    pub fn multiply(&self, x: &[f64], output: &mut [f64]) -> Result<(), Error> {
        if x.len() != self.n || output.len() != self.n {
            return Err(Error::InvalidShape);
        }
        for (row, result) in output.iter_mut().enumerate() {
            *result = (self.rows[row]..self.rows[row + 1])
                .map(|i| self.values[i] * x[self.columns[i]])
                .sum();
        }
        if output.iter().any(|v| !v.is_finite()) {
            return Err(Error::NonFinite);
        }
        Ok(())
    }
    pub fn check_symmetry(&self) -> Result<(), Error> {
        for row in 0..self.n {
            for i in self.rows[row]..self.rows[row + 1] {
                if self.entry(self.columns[i], row).unwrap_or(0.0) != self.values[i] {
                    return Err(Error::NotSymmetric);
                }
            }
        }
        Ok(())
    }
}
