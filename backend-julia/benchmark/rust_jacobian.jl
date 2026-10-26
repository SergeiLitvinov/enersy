using EnersyCompute, SparseArrays, LinearAlgebra, JSON, SHA
include(joinpath(@__DIR__, "..", "test", "fixtures", "network_families.jl"))
const EC = EnersyCompute

write_indices(io, values) = write(io, htol.(UInt64.(values)))
function write_matrix(path, J)
    open(path, "w") do io
        write(io, "ENJOUT01"); write_indices(io, [size(J, 1), nnz(J)])
        write_indices(io, J.colptr .- 1); write_indices(io, rowvals(J) .- 1); write(io, nonzeros(J))
    end
end

function prepare(family, n, prefix)
    ENDIAN_BOM == 0x04030201 || error("binary float protocol requires little endian")
    4 <= n <= 100_000 || error("benchmark size is 4..100000")
    net = manufactured_network(family, n)
    v, theta = abs.(net.voltage), angle.(net.voltage)
    powers = EC.bus_powers(net.Y, v, theta)
    pv = [i for i in 2:n if i % 7 == 0]
    pq = [i for i in 2:n if i % 7 != 0]
    demands = [EC.VoltageDemand(i, 0.001, 0.002, 0.003, 0.004) for (k, i) in enumerate(pq) if k % 10 == 0]
    setup = EC.PowerFlowSetup(n, 1, 1.0, 0.0, pv, pq, v[pv], powers.P[pv], powers.P[pq], powers.Q[pq]; voltage_demands=demands)
    operation() = EC.jacobian(net.Y, v, theta, powers.P, powers.Q, setup)
    first = @timed operation()
    for _ in 1:3; operation(); end
    samples = []
    J = first.value[1]
    for _ in 1:9
        GC.gc()
        timed = @timed operation()
        J = timed.value[1]
        push!(samples, Dict("seconds" => timed.time, "allocated_bytes" => timed.bytes, "gc_seconds" => timed.gctime))
    end
    serialization = @elapsed open(prefix * ".input.bin", "w") do io
        write(io, "ENJAC001"); write_indices(io, [n, 0, length(pv), length(pq), nnz(net.Y)])
        write_indices(io, pv .- 1); write_indices(io, pq .- 1)
        write_indices(io, net.Y.colptr .- 1); write_indices(io, rowvals(net.Y) .- 1)
        for values in (real.(nonzeros(net.Y)), imag.(nonzeros(net.Y)), v, theta, powers.P, powers.Q); write(io, values); end
        write_indices(io, [length(demands)])
        for d in demands
            write_indices(io, [d.bus - 1]); write(io, [d.p_i, d.p_z, d.q_i, d.q_z])
        end
    end
    write_matrix(prefix * ".julia.bin", J)
    root = dirname(@__DIR__)
    files = [@__FILE__, joinpath(root, "test", "fixtures", "network_families.jl"), joinpath(root, "Project.toml"), joinpath(root, "Manifest.toml")]
    append!(files, [joinpath(directory, file) for (directory, _, names) in walkdir(joinpath(root, "src")) for file in names if endswith(file, ".jl")])
    report = Dict("family" => family, "buses" => n, "seed" => "20261021", "pv_buses" => length(pv), "zip_demands" => length(demands),
        "scope" => "Jacobian at a manufactured nonflat state with mixed PV/PQ and ZIP derivatives; no power-flow solve",
        "samples" => samples, "first_call_seconds" => first.time, "serialization_seconds" => serialization,
        "dimension" => size(J, 1), "nnz" => nnz(J), "julia_version" => string(Base.VERSION),
        "julia_threads" => Threads.nthreads(), "blas_threads" => BLAS.get_num_threads(), "cpu" => Sys.CPU_NAME,
        "container_peak_bytes" => isfile("/sys/fs/cgroup/memory.peak") ? parse(UInt64, strip(read("/sys/fs/cgroup/memory.peak", String))) : nothing,
        "input_sha256" => bytes2hex(sha256(read(prefix * ".input.bin"))),
        "source_sha256" => Dict(replace(relpath(path, root), '\\' => '/') => bytes2hex(sha256(read(path))) for path in files))
    write(prefix * ".julia.json", JSON.json(report))
end

function read_matrix(path)
    filesize(path) <= 256 * 1024^2 || error("matrix file too large")
    open(path) do io
        String(read(io, 8)) == "ENJOUT01" || error("invalid matrix version")
        dimension, nz = Int(ltoh(read(io, UInt64))), Int(ltoh(read(io, UInt64)))
        0 < dimension <= 200_000 && 0 <= nz <= 8_000_000 || error("matrix size limit")
        columns = Int.(ltoh.(read!(io, Vector{UInt64}(undef, dimension + 1)))) .+ 1
        rows = Int.(ltoh.(read!(io, Vector{UInt64}(undef, nz)))) .+ 1
        values = read!(io, Vector{Float64}(undef, nz))
        eof(io) && first(columns) == 1 && last(columns) == nz + 1 && issorted(columns) || error("invalid matrix bounds")
        all(i -> 1 <= i <= dimension, rows) && all(isfinite, values) || error("invalid matrix data")
        for col in 1:dimension
            segment = @view rows[columns[col]:columns[col + 1]-1]
            all(>(0), diff(segment)) || error("noncanonical matrix")
        end
        SparseMatrixCSC(dimension, dimension, columns, rows, values)
    end
end

function validate(directory)
    names = JSON.parse(read(joinpath(directory, "cases.json"), String))
    records = []
    for name in names
        occursin(r"^(radial|ring|mesh)-[0-9]+$", name) || error("invalid case name")
        prefix = joinpath(directory, name)
        expected, actual = read_matrix(prefix * ".julia.bin"), read_matrix(prefix * ".rust.bin")
        size(expected) == size(actual) || error("Jacobian dimension differs")
        difference = maximum(abs, actual - expected)
        bound = 1e-11 + 1e-12 * maximum(abs, expected)
        difference <= bound || error("Rust/Julia derivative mismatch: $name, error=$difference bound=$bound")
        push!(records, Dict("case" => name, "max_abs_error" => difference, "tolerance" => bound,
            "julia" => JSON.parse(read(prefix * ".julia.json", String)), "rust" => JSON.parse(read(prefix * ".rust.json", String))))
        println(JSON.json(Dict("case" => name, "max_abs_error" => difference, "status" => "passed")))
    end
    write(joinpath(directory, "comparison.json"), JSON.json(Dict("schema_version" => 1, "records" => records)))
end

if ARGS[1] == "prepare"
    length(ARGS) == 4 || error("prepare family buses prefix")
    prepare(ARGS[2], parse(Int, ARGS[3]), ARGS[4])
elseif ARGS[1] == "validate"
    length(ARGS) == 2 || error("validate directory")
    validate(ARGS[2])
else
    error("unknown action")
end
