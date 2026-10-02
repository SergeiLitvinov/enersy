using EnersyCompute, SparseArrays, LinearAlgebra, JSON3
include(joinpath(@__DIR__, "..", "test", "fixtures", "sparse_star.jl"))
const EC = EnersyCompute
const options = SolverOptions(tolerance=1e-10, max_iterations=20)

# Warm both dispatch paths before recording. These are kernel measurements,
# excluding compilation of editor DTO, transport, JSON results and cold JIT.
for dense in [false, true]
    Y, setup, _, _ = analytical_star(8)
    EC.newton_raphson(dense ? Matrix(Y) : Y, setup, options)
end
records = []
for n in [1000, 10_000, 100_000]
    Y, setup, expected, _ = analytical_star(n)
    for storage in (n == 1000 ? ["dense", "csc"] : ["csc"])
        matrix = storage == "dense" ? Matrix(Y) : Y
        samples = []
        result = nothing
        for _ in 1:3
            GC.gc()
            timed = @timed EC.newton_raphson(matrix, setup, options)
            result = timed.value
            push!(samples, Dict("seconds"=>timed.time, "allocated_bytes"=>timed.bytes,
                                "gc_seconds"=>timed.gctime))
        end
        err = maximum(abs, result.voltages[2:end] .- expected)
        err < 1e-8 && result.max_mismatch < options.tolerance || error("analytical accuracy failed at $n")
        powers = EC.bus_powers(matrix, result.v, result.theta)
        J, _, _ = EC.jacobian(matrix, result.v, result.theta, powers.P, powers.Q, setup)
        record = Dict("buses"=>n, "branches"=>n-1, "storage"=>storage,
            "samples"=>samples, "iterations"=>result.iterations,
            "max_voltage_error_pu"=>err, "max_mismatch_pu"=>result.max_mismatch,
            "y_bytes"=>Base.summarysize(matrix), "j_bytes"=>Base.summarysize(J),
            "y_nnz"=>nnz(Y), "j_nnz"=>storage == "csc" ? nnz(J) : count(!iszero, J),
            "process_max_rss_bytes_so_far"=>Sys.maxrss())
        push!(records, record)
        println(JSON3.write(record)); flush(stdout)
    end
end
report = Dict("schema_version"=>1, "julia_version"=>string(Base.VERSION),
    "julia_threads"=>Threads.nthreads(), "blas_threads"=>BLAS.get_num_threads(),
    "cpu"=>Sys.CPU_NAME, "word_size"=>Sys.WORD_SIZE,
    "scope"=>"Warm numerical kernel; analytical star only; no compiler/API/UI measurement",
    "base_mva"=>100, "base_kv"=>110, "branch_z_pu"=>[0.01,0.1],
    "voltage_tolerance_pu"=>1e-8, "mismatch_tolerance_pu"=>options.tolerance,
    "samples_per_case"=>3, "records"=>records)
isempty(ARGS) || write(ARGS[1], JSON3.write(report))
