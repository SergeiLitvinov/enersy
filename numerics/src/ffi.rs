//! C ABI v1 for trusted in-process callers. Buffers remain caller-owned and are
//! never retained. Integer handles avoid exposing Rust allocation addresses.
//! Null/alignment/range/overlap checks cannot prove that a pointer is mapped:
//! the caller must provide valid, live memory and prevent concurrent mutation.
#![deny(unsafe_op_in_unsafe_fn)]
#[cfg(not(target_pointer_width = "64"))]
compile_error!("C ABI v1 requires a 64-bit target; the safe core has no such restriction");
#[cfg(panic = "abort")]
compile_error!("C ABI v1 requires panic=unwind for boundary containment");

use crate::{
    jacobian::{JacobianPlan, PolarState, VoltageDemand},
    Error,
};
use std::{
    collections::HashMap,
    mem::{align_of, size_of},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

pub const ABI_VERSION: u32 = 1;
pub const OK: i32 = 0;
pub const INVALID_ABI: i32 = 1;
pub const INVALID_BUFFER: i32 = 2;
pub const INVALID_PATTERN: i32 = 3;
pub const NON_FINITE: i32 = 4;
pub const INVALID_VOLTAGE: i32 = 5;
pub const INVALID_HANDLE: i32 = 6;
pub const PANIC: i32 = 7;
pub const INTERNAL: i32 = 8;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Input<T> {
    pub data: *const T,
    pub len: u64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Output<T> {
    pub data: *mut T,
    pub len: u64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlanInfo {
    pub handle: u64,
    pub dimension: u64,
    pub nonzeros: u64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Demand {
    pub bus: u64,
    pub p_i: f64,
    pub p_z: f64,
    pub q_i: f64,
    pub q_z: f64,
}

static PLANS: OnceLock<Mutex<HashMap<u64, Arc<JacobianPlan>>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
fn next_handle(counter: &AtomicU64) -> Result<u64, i32> {
    // Keep the Rust 1.85 MSRV and refuse wraparound instead of reusing a handle.
    let mut current = counter.load(Ordering::Relaxed);
    loop {
        let next = current.checked_add(1).ok_or(INTERNAL)?;
        match counter.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(id) => return Ok(id),
            Err(actual) => current = actual,
        }
    }
}
fn plans() -> &'static Mutex<HashMap<u64, Arc<JacobianPlan>>> {
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn lookup(id: u64) -> Result<Arc<JacobianPlan>, i32> {
    plans()
        .lock()
        .map_err(|_| INTERNAL)?
        .get(&id)
        .cloned()
        .ok_or(INVALID_HANDLE)
}
fn guard(operation: impl FnOnce() -> Result<(), i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => OK,
        Ok(Err(code)) => code,
        Err(_) => PANIC,
    }
}
fn code(error: Error) -> i32 {
    match error {
        Error::NonFinite => NON_FINITE,
        Error::InvalidVoltage => INVALID_VOLTAGE,
        Error::InvalidShape => INVALID_PATTERN,
        _ => INTERNAL,
    }
}

#[derive(Clone, Copy)]
struct Range {
    start: usize,
    end: usize,
}
fn range<T>(data: *const T, len: u64) -> Result<Range, i32> {
    let count = usize::try_from(len).map_err(|_| INVALID_BUFFER)?;
    let bytes = count
        .checked_mul(size_of::<T>())
        .filter(|&n| n <= isize::MAX as usize)
        .ok_or(INVALID_BUFFER)?;
    if bytes == 0 {
        return Ok(Range { start: 0, end: 0 });
    }
    let start = data as usize;
    if data.is_null() || start % align_of::<T>() != 0 {
        return Err(INVALID_BUFFER);
    }
    Ok(Range {
        start,
        end: start.checked_add(bytes).ok_or(INVALID_BUFFER)?,
    })
}
fn overlaps(a: Range, b: Range) -> bool {
    a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end
}
fn disjoint(output: Range, inputs: &[Range]) -> Result<(), i32> {
    if inputs.iter().any(|&i| overlaps(output, i)) {
        Err(INVALID_BUFFER)
    } else {
        Ok(())
    }
}
unsafe fn input<'a, T>(buffer: Input<T>) -> Result<&'a [T], i32> {
    range(buffer.data, buffer.len)?;
    if buffer.len == 0 {
        return Ok(&[]);
    }
    // SAFETY: caller guarantees the checked nonempty buffer is valid/live for
    // this call. No reference escapes the exported operation.
    Ok(unsafe { std::slice::from_raw_parts(buffer.data, buffer.len as usize) })
}
unsafe fn output<'a, T: Copy + Default>(buffer: Output<T>) -> Result<&'a mut [T], i32> {
    range(buffer.data, buffer.len)?;
    if buffer.len == 0 {
        return Ok(&mut []);
    }
    // SAFETY: checked, caller-owned writable storage with exclusive access.
    // Initialize via raw writes before forming references: C output memory
    // may be uninitialized. T is Copy (no destructor is skipped).
    for i in 0..buffer.len as usize {
        unsafe { buffer.data.add(i).write(T::default()) };
    }
    // SAFETY: all elements are now initialized; exports rejected aliasing.
    Ok(unsafe { std::slice::from_raw_parts_mut(buffer.data, buffer.len as usize) })
}

#[no_mangle]
pub extern "C" fn enersy_numerics_abi_version() -> u32 {
    ABI_VERSION
}

/// Create an immutable plan; all indices and offsets are zero-based u64.
/// # Safety
/// Every nonempty buffer must be valid for its declared length for the entire
/// call; info must be writable and disjoint from inputs. No concurrent writes.
#[no_mangle]
pub unsafe extern "C" fn enersy_jacobian_create_v1(
    abi: u32,
    n: u64,
    slack: u64,
    pv: Input<u64>,
    pq: Input<u64>,
    columns: Input<u64>,
    rows: Input<u64>,
    info: *mut PlanInfo,
) -> i32 {
    guard(|| {
        if abi != ABI_VERSION {
            return Err(INVALID_ABI);
        }
        let target = range(info, 1)?;
        disjoint(
            target,
            &[
                range(pv.data, pv.len)?,
                range(pq.data, pq.len)?,
                range(columns.data, columns.len)?,
                range(rows.data, rows.len)?,
            ],
        )?;
        // SAFETY: buffer contracts and non-aliasing were checked above.
        let (pv, pq, columns, rows) =
            unsafe { (input(pv)?, input(pq)?, input(columns)?, input(rows)?) };
        let convert = |values: &[u64]| {
            values
                .iter()
                .map(|&v| usize::try_from(v).map_err(|_| INVALID_PATTERN))
                .collect::<Result<Vec<_>, _>>()
        };
        let plan = Arc::new(
            JacobianPlan::new(
                usize::try_from(n).map_err(|_| INVALID_PATTERN)?,
                usize::try_from(slack).map_err(|_| INVALID_PATTERN)?,
                &convert(pv)?,
                &convert(pq)?,
                &convert(columns)?,
                &convert(rows)?,
            )
            .map_err(code)?,
        );
        let id = next_handle(&NEXT)?;
        let value = PlanInfo {
            handle: id,
            dimension: plan.dimension() as u64,
            nonzeros: plan.row_indices().len() as u64,
        };
        plans().lock().map_err(|_| INTERNAL)?.insert(id, plan);
        // SAFETY: valid disjoint info pointer, no retained input references.
        unsafe { info.write(value) };
        Ok(())
    })
}

/// Copy the plan's canonical CSC pattern into caller-owned buffers.
/// # Safety
/// Nonempty outputs must be valid writable buffers, disjoint from one another,
/// with no concurrent access. No Rust-owned pointer is returned.
#[no_mangle]
pub unsafe extern "C" fn enersy_jacobian_pattern_v1(
    id: u64,
    columns: Output<u64>,
    rows: Output<u64>,
) -> i32 {
    guard(|| {
        let plan = lookup(id)?;
        if columns.len != plan.column_offsets().len() as u64
            || rows.len != plan.row_indices().len() as u64
        {
            return Err(INVALID_BUFFER);
        }
        disjoint(
            range(columns.data, columns.len)?,
            &[range(rows.data, rows.len)?],
        )?;
        // SAFETY: valid, sized and disjoint outputs per caller contract.
        let (columns, rows) = unsafe { (output(columns)?, output(rows)?) };
        for (target, &value) in columns.iter_mut().zip(plan.column_offsets()) {
            *target = value as u64;
        }
        for (target, &value) in rows.iter_mut().zip(plan.row_indices()) {
            *target = value as u64;
        }
        Ok(())
    })
}

/// Update values. On failure discard output; inputs are never retained.
/// # Safety
/// All nonempty buffers must be valid/live, with output disjoint from every
/// input. Prevent concurrent mutation of inputs or any access to output.
#[no_mangle]
pub unsafe extern "C" fn enersy_jacobian_update_v1(
    id: u64,
    g: Input<f64>,
    b: Input<f64>,
    voltage: Input<f64>,
    angle: Input<f64>,
    p: Input<f64>,
    q: Input<f64>,
    demands: Input<Demand>,
    values: Output<f64>,
) -> i32 {
    guard(|| {
        let plan = lookup(id)?;
        disjoint(
            range(values.data, values.len)?,
            &[
                range(g.data, g.len)?,
                range(b.data, b.len)?,
                range(voltage.data, voltage.len)?,
                range(angle.data, angle.len)?,
                range(p.data, p.len)?,
                range(q.data, q.len)?,
                range(demands.data, demands.len)?,
            ],
        )?;
        // SAFETY: input liveness is a caller obligation; output aliasing is
        // rejected before any mutable reference is constructed.
        let (g, b, v, t, p, q, demands, values) = unsafe {
            (
                input(g)?,
                input(b)?,
                input(voltage)?,
                input(angle)?,
                input(p)?,
                input(q)?,
                input(demands)?,
                output(values)?,
            )
        };
        // C Demand uses fixed-width indices; safe core remains platform-native.
        let demands = demands
            .iter()
            .map(|d| {
                Ok(VoltageDemand {
                    bus: usize::try_from(d.bus).map_err(|_| INVALID_PATTERN)?,
                    p_i: d.p_i,
                    p_z: d.p_z,
                    q_i: d.q_i,
                    q_z: d.q_z,
                })
            })
            .collect::<Result<Vec<_>, i32>>()?;
        plan.update(
            g,
            b,
            PolarState {
                voltage: v,
                angle: t,
                p,
                q,
            },
            &demands,
            values,
        )
        .map_err(code)
    })
}

/// Release a handle. Repeated/unknown IDs are rejected. In-flight calls own an
/// Arc lease and may finish safely after removal; buffers remain caller-owned.
#[no_mangle]
pub extern "C" fn enersy_jacobian_destroy_v1(id: u64) -> i32 {
    guard(|| {
        let mut registry = plans().lock().map_err(|_| INTERNAL)?;
        registry.remove(&id).ok_or(INVALID_HANDLE)?;
        if registry.is_empty() {
            registry.shrink_to_fit();
        }
        Ok(())
    })
}

/// Inspect owned handle count, not process memory or concurrent Arc leases.
/// # Safety
/// count must point to writable, aligned u64 storage with exclusive access.
#[no_mangle]
pub unsafe extern "C" fn enersy_jacobian_live_plans_v1(count: *mut u64) -> i32 {
    guard(|| {
        range(count, 1)?;
        let value = plans().lock().map_err(|_| INTERNAL)?.len() as u64;
        // SAFETY: caller guarantees a valid checked scalar output.
        unsafe { count.write(value) };
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source<T>(values: &[T]) -> Input<T> {
        Input {
            data: values.as_ptr(),
            len: values.len() as u64,
        }
    }
    fn target<T>(values: &mut [T]) -> Output<T> {
        Output {
            data: values.as_mut_ptr(),
            len: values.len() as u64,
        }
    }
    #[test]
    fn boundary_layout_ownership_errors_and_aliasing() {
        assert_eq!(size_of::<Input<u64>>(), 16);
        assert_eq!(size_of::<PlanInfo>(), 24);
        assert_eq!(size_of::<Demand>(), 40);
        let mut info = PlanInfo::default();
        let columns = [0, 2, 4];
        let rows = [0, 1, 0, 1];
        let mut count = 99;
        // SAFETY: all test slices/scalars are live and correctly sized. Bad
        // pointers below are rejected before dereference by ABI validation.
        unsafe {
            assert_eq!(
                enersy_jacobian_create_v1(
                    2,
                    2,
                    0,
                    source(&[]),
                    source(&[1]),
                    source(&columns),
                    source(&rows),
                    &mut info
                ),
                INVALID_ABI
            );
            assert_eq!(
                enersy_jacobian_create_v1(
                    1,
                    2,
                    0,
                    source(&[]),
                    source(&[1]),
                    source(&columns),
                    source(&rows),
                    std::ptr::null_mut()
                ),
                INVALID_BUFFER
            );
            assert_eq!(
                enersy_jacobian_create_v1(
                    1,
                    2,
                    0,
                    source(&[]),
                    source(&[1]),
                    source(&columns),
                    source(&rows),
                    &mut info
                ),
                OK
            );
            assert_eq!(enersy_jacobian_live_plans_v1(&mut count), OK);
            assert_eq!(count, 1);
            let (mut jc, mut jr) = (vec![0; 3], vec![0; 4]);
            assert_eq!(
                enersy_jacobian_pattern_v1(info.handle, target(&mut jc), target(&mut jr)),
                OK
            );
            assert_eq!(jc, vec![0, 2, 4]);
            assert_eq!(jr, vec![0, 1, 0, 1]);
            let mut out = vec![0.0; 4];
            let mut g = [1.0, -1.0, -1.0, 1.0];
            assert_eq!(
                enersy_jacobian_update_v1(
                    info.handle,
                    source(&g),
                    source(&[0.0; 4]),
                    source(&[1.0, 0.8]),
                    source(&[0.0; 2]),
                    source(&[0.2, -0.16]),
                    source(&[0.0; 2]),
                    source(&[]),
                    target(&mut out)
                ),
                OK
            );
            assert!((out[2] - 0.6).abs() < 1e-12);
            let shared = Output {
                data: g.as_mut_ptr(),
                len: 4,
            };
            assert_eq!(
                enersy_jacobian_update_v1(
                    info.handle,
                    source(&g),
                    source(&[0.0; 4]),
                    source(&[1.0; 2]),
                    source(&[0.0; 2]),
                    source(&[0.0; 2]),
                    source(&[0.0; 2]),
                    source(&[]),
                    shared
                ),
                INVALID_BUFFER
            );
            let lease = lookup(info.handle).unwrap();
            assert_eq!(enersy_jacobian_destroy_v1(info.handle), OK);
            assert_eq!(Arc::strong_count(&lease), 1);
            let mut retained = [0.0; 4];
            assert!(lease
                .update(
                    &[1.0, -1.0, -1.0, 1.0],
                    &[0.0; 4],
                    PolarState {
                        voltage: &[1.0, 0.8],
                        angle: &[0.0; 2],
                        p: &[0.2, -0.16],
                        q: &[0.0; 2]
                    },
                    &[],
                    &mut retained
                )
                .is_ok());
            drop(lease);
            assert_eq!(enersy_jacobian_destroy_v1(info.handle), INVALID_HANDLE);
            assert_eq!(
                enersy_jacobian_pattern_v1(info.handle, target(&mut jc), target(&mut jr)),
                INVALID_HANDLE
            );
            assert_eq!(enersy_jacobian_live_plans_v1(&mut count), OK);
            assert_eq!(count, 0);
        }
    }
    #[test]
    fn contains_unwind_and_invalid_ranges() {
        assert_eq!(guard(|| panic!("boundary test")), PANIC);
        assert!(range::<f64>(std::ptr::null(), 1).is_err());
        assert!(range::<f64>(std::ptr::dangling::<u8>().cast(), 1).is_err());
        assert!(range::<f64>(std::ptr::dangling::<f64>(), u64::MAX).is_err());
        assert!(range::<f64>(std::ptr::null(), 0).is_ok());
    }

    #[test]
    fn handles_are_unique_and_never_wrap() {
        let counter = AtomicU64::new(1);
        let mut ids = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        (0..128)
                            .map(|_| next_handle(&counter).unwrap())
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        ids.sort_unstable();
        assert_eq!(ids, (1..=1024).collect::<Vec<_>>());
        let exhausted = AtomicU64::new(u64::MAX - 1);
        assert_eq!(next_handle(&exhausted), Ok(u64::MAX - 1));
        assert_eq!(next_handle(&exhausted), Err(INTERNAL));
        assert_eq!(next_handle(&exhausted), Err(INTERNAL));
        assert_eq!(exhausted.load(Ordering::Relaxed), u64::MAX);
    }
}
