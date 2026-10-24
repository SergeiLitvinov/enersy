using EnersyCompute, SparseArrays, LinearAlgebra, JSON3, SHA
include(joinpath(@__DIR__,"..","experimental","RustJacobian.jl"))
include(joinpath(@__DIR__,"..","test","fixtures","network_families.jl"))
const EC = EnersyCompute
const RJ = RustJacobianAdapter

function measure(operation)
    GC.gc()
    timed = @timed operation()
    timed.value, Dict("seconds"=>timed.time,"allocated_bytes"=>timed.bytes,
        "gc_seconds"=>timed.gctime,"iterations"=>timed.value.iterations)
end

function profile(family,n,path)
    4 <= n <= 100_000 || error("benchmark size is 4..100000")
    net = manufactured_network(family,n)
    options = EC.SolverOptions(1e-10,50)
    baseline() = EC.newton_raphson(net.Y,net.setup,options)
    expected, first_julia = measure(baseline)
    julia_samples, native_samples = [], []
    library_path = get(ENV,"ENERSY_NUMERICS_LIBRARY","/opt/enersy/libenersy_numerics.so")
    first_native = nothing
    actual = RJ.with_library(library_path) do library
        native() = RJ.solve_newton(library,net.Y,net.setup,options)
        last, first_native = measure(native)
        baseline(); native()
        for _ in 1:5
            expected, timing = measure(baseline); push!(julia_samples,timing)
            last, timing = measure(native); push!(native_samples,timing)
        end
        RJ.live_plans(library) == 0 || error("native plan leak")
        last
    end
    difference = maximum(abs,actual.voltages-expected.voltages)
    reference_error = maximum(abs,actual.voltages-net.voltage)
    # Independent edge-current reconstruction, outside both timed solvers.
    currents = zeros(ComplexF64,n)
    for (i,j,z) in net.edges
        current = (actual.voltages[i]-actual.voltages[j])/z
        currents[i] += current; currents[j] -= current
    end
    injection = actual.voltages .* conj.(currents)
    residual = maximum(abs,injection[2:end]-net.injection[2:end])
    difference < 1e-8 && residual < 2e-10 || error("complete solve equivalence/circuit failure")
    # A different algebraic root is recorded, never relabeled a passing reference.
    root = dirname(@__DIR__)
    files = [@__FILE__,joinpath(root,"experimental","RustJacobian.jl"),joinpath(root,"test","fixtures","network_families.jl"),joinpath(root,"Project.toml"),joinpath(root,"Manifest.toml")]
    append!(files,[joinpath(dir,file) for (dir,_,names) in walkdir(joinpath(root,"src")) for file in names if endswith(file,".jl")])
    report = Dict("schema_version"=>1,"family"=>family,"buses"=>n,"seed"=>"20261021",
        "scope"=>"Complete flat-start Newton; native plan creation/destruction included; library load excluded; Julia UMFPACK unchanged; no HTTP or Q switching",
        "julia_samples"=>julia_samples,"native_samples"=>native_samples,"first_julia"=>first_julia,"first_native"=>first_native,
        "max_backend_difference_pu"=>difference,"max_reference_voltage_error_pu"=>reference_error,
        "reference_root_matched"=>reference_error<1e-8,"edge_power_residual_pu"=>residual,
        "abi_version"=>1,"library_sha256"=>bytes2hex(sha256(read(library_path))),
        "julia_version"=>string(Base.VERSION),"cpu"=>Sys.CPU_NAME,"julia_threads"=>Threads.nthreads(),"blas_threads"=>BLAS.get_num_threads(),
        "container_peak_bytes"=>parse(UInt64,strip(read("/sys/fs/cgroup/memory.peak",String))),
        "source_sha256"=>Dict(replace(relpath(file,root),'\\'=>'/')=>bytes2hex(sha256(read(file))) for file in files))
    write(path,JSON3.write(report))
    println(JSON3.write(Dict("family"=>family,"buses"=>n,"backend_difference"=>difference,"reference_root_matched"=>reference_error<1e-8)))
end
length(ARGS)==3 || error("usage: rust_newton.jl family buses report.json")
profile(ARGS[1],parse(Int,ARGS[2]),ARGS[3])
