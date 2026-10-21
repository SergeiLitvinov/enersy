using EnersyCompute, SparseArrays, LinearAlgebra, JSON3, SHA
include(joinpath(@__DIR__, "..", "test", "fixtures", "network_families.jl"))
const EC = EnersyCompute

function measure(operation)
    GC.gc() # outside the timer; time/allocations include GC inside the operation
    timed = @timed operation()
    return timed.value, Dict("seconds" => timed.time, "allocated_bytes" => timed.bytes,
                             "gc_seconds" => timed.gctime)
end

function source_hashes()
    root = dirname(@__DIR__)
    paths = [joinpath(root, "Project.toml"), joinpath(root, "Manifest.toml"), @__FILE__,
        joinpath(root, "test", "fixtures", "network_families.jl")]
    for (directory, _, files) in walkdir(joinpath(root, "src")), file in files
        endswith(file, ".jl") && push!(paths, joinpath(directory, file))
    end
    return Dict(replace(relpath(path, root), '\\' => '/') => bytes2hex(sha256(read(path))) for path in sort(paths))
end

read_optional(path) = isfile(path) ? strip(read(path, String)) : nothing

function run_profile(family, n, output, samples)
    4 <= n <= 100_000 || error("supported benchmark size: 4..100000")
    3 <= samples <= 30 || error("samples must be between 3 and 30")
    network, generation = measure(() -> manufactured_network(family, n))
    options = SolverOptions(tolerance=1e-10, max_iterations=20)
    function verify(result)
        error_v = maximum(abs, result.voltages - network.voltage)
        error_v < 1e-8 && result.max_mismatch < options.tolerance || error("manufactured solution mismatch")
        losses = sum(z * abs2((result.voltages[i] - result.voltages[j]) / z) for (i, j, z) in network.edges)
        balance = complex(sum(result.p), sum(result.q)) - losses
        abs(balance) <= 1e-7 + 1e-9 * abs(losses) || error("independent branch power balance failed")
        return Dict("max_voltage_error_pu" => error_v, "max_mismatch_pu" => result.max_mismatch,
            "balance_error_pu" => abs(balance), "iterations" => result.iterations)
    end
    # First call in a new process: includes any JIT triggered here, but excludes
    # process startup, package import and fixture generation. Not total cold start.
    result, first = measure(() -> EC.newton_raphson(network.Y, network.setup, options))
    accuracy = verify(result)
    v, theta = ones(n), zeros(n)
    powers = EC.bus_powers(network.Y, v, theta)
    residual = EC.mismatch_vector(powers, network.setup)
    J, _, _ = EC.jacobian(network.Y, v, theta, powers.P, powers.Q, network.setup)
    factor = lu(J; check=true)
    correction = factor \ residual
    maximum(abs, J * correction - residual) <= 1e-9 * (1 + maximum(abs, residual)) || error("LU residual failed")
    operations = [
        "powers" => (() -> EC.bus_powers(network.Y, v, theta)),
        "mismatch" => (() -> EC.mismatch_vector(powers, network.setup)),
        "jacobian" => (() -> EC.jacobian(network.Y, v, theta, powers.P, powers.Q, network.setup)),
        "factorization" => (() -> lu(J; check=true)),
        "backsolve" => (() -> factor \ residual),
        "full_newton" => (() -> EC.newton_raphson(network.Y, network.setup, options)),
    ]
    records = Dict{String,Any}()
    for (name, operation) in operations
        operation() # warm the benchmark closure separately from production dispatch
        timings = []
        for _ in 1:samples
            value, timing = measure(operation)
            name == "full_newton" && verify(value)
            push!(timings, timing)
        end
        records[name] = timings
    end
    cpu_info = something(read_optional("/proc/cpuinfo"), "")
    cpu = match(r"model name\s*:\s*([^\n]+)", cpu_info)
    report = Dict("schema_version" => 1, "status" => "passed", "family" => family,
        "seed" => string(network.seed), "buses" => n, "branches" => length(network.edges),
        "samples_per_stage" => samples, "julia_version" => string(Base.VERSION),
        "julia_threads" => Threads.nthreads(), "blas_threads" => BLAS.get_num_threads(),
        "cpu" => cpu === nothing ? Sys.CPU_NAME : cpu.captures[1], "kernel" => string(Sys.KERNEL),
        "cpu_quota" => read_optional("/sys/fs/cgroup/cpu.max"),
        "memory_limit_bytes" => read_optional("/sys/fs/cgroup/memory.max"),
        "process_max_rss_bytes" => Sys.maxrss(),
        "container_peak_bytes" => read_optional("/sys/fs/cgroup/memory.peak"),
        "generation_first_call" => generation, "solver_first_call" => first,
        "stage_scope" => "Independent warm probes at flat start; not an additive breakdown of full Newton",
        "base_mva" => 100, "base_kv" => 110, "accuracy" => accuracy,
        "voltage_tolerance_pu" => 1e-8, "mismatch_tolerance_pu" => options.tolerance,
        "balance_absolute_tolerance_pu" => 1e-7, "balance_relative_tolerance" => 1e-9,
        "y_nnz" => nnz(network.Y), "j_nnz" => nnz(J), "lu_nnz" => nnz(factor.L) + nnz(factor.U),
        "y_bytes" => Base.summarysize(network.Y), "j_bytes" => Base.summarysize(J),
        "source_sha256" => source_hashes(), "stages" => records)
    write(output, JSON3.write(report))
    println(JSON3.write(Dict("family" => family, "buses" => n, "accuracy" => accuracy,
        "container_peak_bytes" => report["container_peak_bytes"], "status" => "passed")))
end

length(ARGS) == 4 || error("usage: ac_stages.jl family buses output.json samples")
run_profile(ARGS[1], parse(Int, ARGS[2]), ARGS[3], parse(Int, ARGS[4]))
