#ifndef ENERSY_NUMERICS_H
#define ENERSY_NUMERICS_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define ENERSY_NUMERICS_ABI_V1 1u
enum enersy_status { ENERSY_OK=0, ENERSY_INVALID_ABI=1, ENERSY_INVALID_BUFFER=2,
    ENERSY_INVALID_PATTERN=3, ENERSY_NON_FINITE=4, ENERSY_INVALID_VOLTAGE=5,
    ENERSY_INVALID_HANDLE=6, ENERSY_PANIC=7, ENERSY_INTERNAL=8 };
typedef struct { const uint64_t *data; uint64_t len; } enersy_u64_input;
typedef struct { uint64_t *data; uint64_t len; } enersy_u64_output;
typedef struct { const double *data; uint64_t len; } enersy_f64_input;
typedef struct { double *data; uint64_t len; } enersy_f64_output;
typedef struct { uint64_t handle, dimension, nonzeros; } enersy_plan_info;
typedef struct { uint64_t bus; double p_i, p_z, q_i, q_z; } enersy_demand;
typedef struct { const enersy_demand *data; uint64_t len; } enersy_demand_input;
/* Trusted in-process API, 64-bit targets. All lengths are element counts.
 * Nonempty buffers must be valid/aligned/live. Output must not overlap inputs
 * or other outputs. Caller prevents concurrent mutation. No pointers retained.
 * Indices/CSC offsets are zero-based. Discard numeric output on any error.
 * Catching Rust panics does not protect against invalid mapped-memory claims,
 * process termination or OOM. The worker process supplies isolation/limits. */
uint32_t enersy_numerics_abi_version(void);
int32_t enersy_jacobian_create_v1(uint32_t abi, uint64_t n, uint64_t slack,
    enersy_u64_input pv, enersy_u64_input pq, enersy_u64_input columns,
    enersy_u64_input rows, enersy_plan_info *info);
int32_t enersy_jacobian_pattern_v1(uint64_t handle, enersy_u64_output columns, enersy_u64_output rows);
int32_t enersy_jacobian_update_v1(uint64_t handle, enersy_f64_input g, enersy_f64_input b,
    enersy_f64_input voltage, enersy_f64_input angle, enersy_f64_input p,
    enersy_f64_input q, enersy_demand_input demands, enersy_f64_output values);
int32_t enersy_jacobian_destroy_v1(uint64_t handle);
int32_t enersy_jacobian_live_plans_v1(uint64_t *count);
#ifdef __cplusplus
}
#endif
#endif
