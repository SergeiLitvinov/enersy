//! Benchmark-only bounded binary interchange. Not a public model/worker protocol.
use enersy_numerics::jacobian::{JacobianPlan, PolarState, VoltageDemand};
use std::{fs, hint::black_box, io::Write, time::Instant};

struct Reader {
    bytes: Vec<u8>,
    offset: usize,
}
impl Reader {
    fn word(&mut self) -> Result<[u8; 8], String> {
        let end = self.offset.checked_add(8).ok_or("offset overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("truncated input")?
            .try_into()
            .map_err(|_| "word")?;
        self.offset = end;
        Ok(value)
    }
    fn integer(&mut self) -> Result<usize, String> {
        usize::try_from(u64::from_le_bytes(self.word()?)).map_err(|_| "integer overflow".into())
    }
    fn integers(&mut self, n: usize) -> Result<Vec<usize>, String> {
        (0..n).map(|_| self.integer()).collect()
    }
    fn floats(&mut self, n: usize) -> Result<Vec<f64>, String> {
        (0..n)
            .map(|_| self.word().map(f64::from_le_bytes))
            .collect()
    }
}
fn execute(args: &[String]) -> Result<(), String> {
    if args.len() != 4 {
        return Err("usage: jacobian_probe input.bin output.bin report.json".into());
    }
    let load = Instant::now();
    if fs::metadata(&args[1]).map_err(|e| e.to_string())?.len() > 256 * 1024 * 1024 {
        return Err("input exceeds 256 MiB".into());
    }
    let mut reader = Reader {
        bytes: fs::read(&args[1]).map_err(|e| e.to_string())?,
        offset: 0,
    };
    if &reader.word()? != b"ENJAC001" {
        return Err("unknown binary version".into());
    }
    let (n, slack, npv, npq, nnz) = (
        reader.integer()?,
        reader.integer()?,
        reader.integer()?,
        reader.integer()?,
        reader.integer()?,
    );
    if n == 0 || n > 100_000 || npv > n || npq > n || nnz > 20 * n {
        return Err("benchmark size limit".into());
    }
    let (pv, pq, columns, rows) = (
        reader.integers(npv)?,
        reader.integers(npq)?,
        reader.integers(n + 1)?,
        reader.integers(nnz)?,
    );
    let (g, b, v, theta, p, q) = (
        reader.floats(nnz)?,
        reader.floats(nnz)?,
        reader.floats(n)?,
        reader.floats(n)?,
        reader.floats(n)?,
        reader.floats(n)?,
    );
    let nd = reader.integer()?;
    if nd > 1_000_000 {
        return Err("demand limit".into());
    }
    let mut demands = Vec::with_capacity(nd);
    for _ in 0..nd {
        let bus = reader.integer()?;
        let values = reader.floats(4)?;
        demands.push(VoltageDemand {
            bus,
            p_i: values[0],
            p_z: values[1],
            q_i: values[2],
            q_z: values[3],
        });
    }
    if reader.offset != reader.bytes.len() {
        return Err("trailing input".into());
    }
    let load_ns = load.elapsed().as_nanos();
    let create =
        || JacobianPlan::new(n, slack, &pv, &pq, &columns, &rows).map_err(|e| format!("{e:?}"));
    let start = Instant::now();
    let plan = create()?;
    let first_plan_ns = start.elapsed().as_nanos();
    let state = || PolarState {
        voltage: &v,
        angle: &theta,
        p: &p,
        q: &q,
    };
    let mut values = vec![0.0; plan.row_indices().len()];
    let start = Instant::now();
    plan.update(&g, &b, state(), &demands, &mut values)
        .map_err(|e| format!("{e:?}"))?;
    let first_update_ns = start.elapsed().as_nanos();
    for _ in 0..3 {
        plan.update(&g, &b, state(), &demands, &mut values)
            .map_err(|e| format!("{e:?}"))?;
        black_box(&values);
    }
    let (mut plans, mut updates, mut fresh) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..9 {
        let start = Instant::now();
        let new_plan = create()?;
        plans.push(start.elapsed().as_nanos());
        black_box(&new_plan);
        drop(new_plan);
        let start = Instant::now();
        plan.update(&g, &b, state(), &demands, &mut values)
            .map_err(|e| format!("{e:?}"))?;
        updates.push(start.elapsed().as_nanos());
        black_box(&values);
        let start = Instant::now();
        let new_plan = create()?;
        let mut buffer = vec![0.0; new_plan.row_indices().len()];
        new_plan
            .update(&g, &b, state(), &demands, &mut buffer)
            .map_err(|e| format!("{e:?}"))?;
        fresh.push(start.elapsed().as_nanos());
        black_box(&buffer);
    }
    let save = Instant::now();
    let mut file = std::io::BufWriter::new(fs::File::create(&args[2]).map_err(|e| e.to_string())?);
    file.write_all(b"ENJOUT01").map_err(|e| e.to_string())?;
    for value in [plan.dimension(), values.len()] {
        file.write_all(&(value as u64).to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    for &value in plan.column_offsets().iter().chain(plan.row_indices()) {
        file.write_all(&(value as u64).to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    for &value in &values {
        file.write_all(&value.to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    let save_ns = save.elapsed().as_nanos();
    let peak = fs::read_to_string("/sys/fs/cgroup/memory.peak")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|v| v.to_string())
        .unwrap_or("null".into());
    let report=format!("{{\"schema_version\":1,\"dimension\":{},\"pattern_nnz\":{},\"input_bytes\":{},\"load_ns\":{load_ns},\"save_ns\":{save_ns},\"first_plan_ns\":{first_plan_ns},\"first_update_ns\":{first_update_ns},\"plan_ns\":{plans:?},\"update_ns\":{updates:?},\"fresh_ns\":{fresh:?},\"container_peak_bytes\":{peak}}}",plan.dimension(),values.len(),reader.bytes.len());
    fs::write(&args[3], report).map_err(|e| e.to_string())?;
    Ok(())
}
fn main() {
    if let Err(error) = execute(&std::env::args().collect::<Vec<_>>()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
