using EnersyCompute, SparseArrays, LinearAlgebra, JSON3, SHA
include(joinpath(@__DIR__, "..", "experimental", "RustJacobian.jl"))
include(joinpath(@__DIR__, "..", "test", "fixtures", "network_families.jl"))
const EC = EnersyCompute
const RJ = RustJacobianAdapter

function sample(operation)
    GC.gc()
    timed = @timed operation()
    return timed.value, Dict("seconds"=>timed.time,"allocated_bytes"=>timed.bytes,"gc_seconds"=>timed.gctime)
end
function profile(family,n,path)
    4 <= n <= 100_000 || error("benchmark size is 4..100000")
    net = manufactured_network(family,n)
    v, theta = abs.(net.voltage), angle.(net.voltage)
    powers = EC.bus_powers(net.Y,v,theta)
    pv, pq = [i for i in 2:n if i%7==0], [i for i in 2:n if i%7!=0]
    demands = [EC.VoltageDemand(i,0.001,0.002,0.003,0.004) for (k,i) in enumerate(pq) if k%10==0]
    setup = EC.PowerFlowSetup(n,1,1.0,0.0,pv,pq,v[pv],powers.P[pv],powers.P[pq],powers.Q[pq];voltage_demands=demands)
    baseline() = EC.jacobian(net.Y,v,theta,powers.P,powers.Q,setup)[1]
    baseline()
    for _ in 1:3; baseline(); end
    julia_samples = []; expected = baseline()
    for _ in 1:9
        expected,timing = sample(baseline)
        push!(julia_samples,timing)
    end
    native_samples = []; times = Ref{UInt64}(0)
    library_path = get(ENV,"ENERSY_NUMERICS_LIBRARY","/opt/enersy/libenersy_numerics.so")
    opened = time_ns(); library_first_seconds = 0.0; plan_first_seconds = 0.0; first_call_seconds = 0.0
    J = RJ.with_library(library_path) do library
        library_first_seconds = (time_ns()-opened)/1e9
        @assert RJ.live_plans(library)==0
        started = time_ns()
        result = RJ.with_plan(library,net.Y,setup) do plan
            plan_first_seconds = (time_ns()-started)/1e9
            operation() = RJ.assemble(plan,net.Y,v,theta,powers.P,powers.Q,setup;native_ns=times)
            first = @timed operation()
            first_call_seconds = first.time
            for _ in 1:3; operation(); end
            last = first.value
            for _ in 1:9
                last,timing = sample(operation)
                timing["foreign_call_ns"] = times[]
                push!(native_samples,timing)
            end
            last
        end
        @assert RJ.live_plans(library)==0
        result
    end
    # Full matrix comparison is outside all timers, after both scopes close.
    difference = maximum(abs,J-expected)
    bound = 1e-11+1e-12*maximum(abs,expected)
    difference <= bound || error("FFI Jacobian mismatch")
    root = dirname(@__DIR__)
    files = [@__FILE__,joinpath(root,"experimental","RustJacobian.jl"),joinpath(root,"test","fixtures","network_families.jl"),joinpath(root,"Project.toml"),joinpath(root,"Manifest.toml")]
    append!(files,[joinpath(directory,file) for (directory,_,names) in walkdir(joinpath(root,"src")) for file in names if endswith(file,".jl")])
    report = Dict("schema_version"=>1,"family"=>family,"buses"=>n,"pv_buses"=>length(pv),"zip_demands"=>length(demands),
        "seed"=>"20261021","julia_samples"=>julia_samples,"ffi_samples"=>native_samples,"max_abs_error"=>difference,"tolerance"=>bound,
        "scope"=>"Warm Jacobian only; FFI wrapper includes validation, complex/ZIP conversion and owned CSC copies; no Newton solve",
        "library_first_seconds"=>library_first_seconds,"plan_first_seconds"=>plan_first_seconds,"first_ffi_seconds"=>first_call_seconds,
        "abi_version"=>1,"library_sha256"=>bytes2hex(sha256(read(library_path))),"julia_version"=>string(Base.VERSION),
        "julia_threads"=>Threads.nthreads(),"blas_threads"=>BLAS.get_num_threads(),"cpu"=>Sys.CPU_NAME,
        "container_peak_bytes"=>parse(UInt64,strip(read("/sys/fs/cgroup/memory.peak",String))),
        "source_sha256"=>Dict(replace(relpath(file,root),'\\'=>'/')=>bytes2hex(sha256(read(file))) for file in files))
    write(path,JSON3.write(report))
    println(JSON3.write(Dict("family"=>family,"buses"=>n,"max_abs_error"=>difference,"status"=>"passed")))
end
length(ARGS)==3 || error("usage: rust_ffi.jl family buses report.json")
profile(ARGS[1],parse(Int,ARGS[2]),ARGS[3])
