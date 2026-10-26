using EnersyCompute,SparseArrays,LinearAlgebra,JSON,SHA
const EC=EnersyCompute
include(joinpath(@__DIR__,"..","test","fixtures","network_families.jl"))
include(joinpath(@__DIR__,"diagnostics","root_curvature.jl"))
const RC=RootCurvatureDiagnostics
BLAS.set_num_threads(1)

function independent_accuracy(network,result;scale=1.0)
    currents=zeros(ComplexF64,network.setup.nbus)
    losses=0.0im
    for (i,j,z) in network.edges
        current=(result.voltages[i]-result.voltages[j])/z
        currents[i]+=current;currents[j]-=current
        losses+=z*abs2(current)
    end
    power=result.voltages.*conj.(currents)
    mismatch=maximum(abs,power[2:end]-scale.*network.injection[2:end])
    balance=abs(sum(power)-losses)
    mismatch<1e-10 && balance<=1e-7+1e-9*abs(losses) || error("independent edge equations/balance failed")
    reference_error=maximum(abs,result.voltages-network.voltage)
    Dict("edge_mismatch_pu"=>mismatch,"balance_error_pu"=>balance,
        "voltage_reference_error_pu"=>reference_error,"matches_reference"=>scale==1 && reference_error<1e-8,
        "voltage_min_pu"=>minimum(result.v),"voltage_max_pu"=>maximum(result.v),
        "iterations"=>result.iterations,"solver_mismatch_pu"=>result.max_mismatch,
        "slack_pq_pu"=>[real(power[1]),imag(power[1])],"loss_pq_pu"=>[real(losses),imag(losses)])
end

function curvature_record(network,voltage,output,label)
    H=RC.edge_hessian(network.setup,network.edges,voltage;common_impedance=0.01+0.1im)
    classified=RC.classify(H)
    record=Dict{String,Any}("scope"=>"special-uniform-RX-constant-PQ-algebraic-curvature",
        "dynamic_stability_certified"=>false,"status"=>classified.status,
        "negative_pivots"=>classified.negative_pivots,"minimum_pivot"=>classified.min_pivot,"hessian_nnz"=>nnz(H))
    if classified.witness!==nothing
        quadratic=RC.edge_quadratic(network.setup,network.edges,voltage,classified.witness;common_impedance=0.01+0.1im)
        quadratic<0 || error("negative edge quadratic not reproduced")
        path=joinpath(dirname(output),"witness-$(network.setup.nbus)-$label.f64")
        open(path,"w") do io;write(io,classified.witness);end
        record["quadratic_float64"]=classified.rayleigh
        record["quadratic_edge_128bit"]=string(quadratic)
        record["witness"]=Dict("file"=>basename(path),"sha256"=>bytes2hex(sha256(read(path))),
            "dtype"=>"Float64","length"=>length(classified.witness),
            "byte_order"=>Base.ENDIAN_BOM==0x04030201 ? "little" : "big",
            "coordinates"=>"theta[pq] in rad, rho[pq]=log(abs(V_pu)); slack excluded")
    end
    record
end

function probe(network,mode,output)
    options=SolverOptions(tolerance=1e-10,max_iterations=20)
    record=Dict{String,Any}("buses"=>network.setup.nbus,"mode"=>mode,"stages"=>Any[])
    control=EC.CalculationControl(max_time_ms=120000)
    started=time_ns()
    try
        local final_voltage
        if startswith(mode,"power_ramp_")
            count=parse(Int,split(mode,'_')[end])
            v,theta=ones(network.setup.nbus),zeros(network.setup.nbus)
            for k in 1:count
                scale=k/count;s=network.setup
                setup=EC.PowerFlowSetup(s.nbus,s.slack,s.slack_v,s.slack_theta,s.pv,s.pq,s.pv_v,
                    scale.*s.p_pv,scale.*s.p_pq,scale.*s.q_pq)
                result=EC.newton_raphson(network.Y,setup,options;initial_v=v,initial_theta=theta,control)
                accuracy=independent_accuracy(network,result;scale)
                accuracy["power_scale"]=scale
                push!(record["stages"],accuracy)
                v,theta=result.v,result.theta
            end
            # Curvature at the final target equations only.
            final_voltage=v.*cis.(theta)
        else
            n=network.setup.nbus
            kwargs=mode=="oracle_neighborhood_only" ?
                (;initial_v=abs.(network.voltage).+[i==1 ? 0.0 : 1e-4*sin(i) for i in 1:n],
                  initial_theta=angle.(network.voltage).+[i==1 ? 0.0 : 1e-4*cos(i) for i in 1:n]) : (;)
            result=EC.newton_raphson(network.Y,network.setup,options;kwargs...,control)
            push!(record["stages"],independent_accuracy(network,result))
            final_voltage=result.voltages
        end
        EC.execution_checkpoint(control,:root_curvature_start)
        record["curvature"]=curvature_record(network,final_voltage,output,mode)
        EC.execution_checkpoint(control,:root_curvature_finished)
        record["status"]="equations_verified"
    catch err
        # Refusal is retained, never re-labelled as an accepted root or retried
        # with the manufactured voltage as a hidden solver fallback.
        record["status"]="diagnostic_refused"
        record["error"]=sprint(showerror,err)
    end
    record["single_probe_wall_seconds"]=(time_ns()-started)/1e9
    println(JSON.json(record));flush(stdout)
    record
end

function run_diagnostic(output,sizes)
    report=Dict{String,Any}("schema_version"=>1,"scope"=>"root-selection-diagnostic-not-production-policy",
        "status"=>"running","defect_closed"=>false,"dynamic_stability_certified"=>false,
        "julia_version"=>string(Base.VERSION),"engine_version"=>EC.VERSION,"base_mva"=>100,"base_kv"=>110,
        "seed"=>20261021,"mismatch_tolerance_pu"=>1e-10,"reference_tolerance_pu"=>1e-8,
        "balance_absolute_tolerance_pu"=>1e-7,"balance_relative_tolerance"=>1e-9,"max_newton_iterations"=>20,
        "per_probe_cooperative_budget_ms"=>120000,"oracle_neighborhood_is_not_an_initialization_algorithm"=>true,
        "ramp_is_not_predictor_corrector_CPF"=>true,
        "timing_scope"=>"Single diagnostic probes including first-use compilation; not a performance comparison",
        "cpu_quota"=>optional_runtime_file("/sys/fs/cgroup/cpu.max"),"memory_limit_bytes"=>optional_runtime_file("/sys/fs/cgroup/memory.max"),
        "records"=>Any[])
    root=dirname(@__DIR__)
    files=[joinpath(root,"Project.toml"),joinpath(root,"Manifest.toml"),@__FILE__,
        joinpath(@__DIR__,"diagnostics","root_curvature.jl"),joinpath(root,"test","fixtures","network_families.jl")]
    for (directory,_,names) in walkdir(joinpath(root,"src")),name in names
        endswith(name,".jl") && push!(files,joinpath(directory,name))
    end
    report["source_sha256"]=Dict(replace(relpath(path,root),'\\'=>'/')=>bytes2hex(sha256(read(path))) for path in files)
    for n in sizes
        4<=n<=100000 || error("diagnostic size must be 4..100000")
        network=manufactured_network("radial",n)
        modes=n==100000 ? ("flat","power_ramp_4","power_ramp_20","oracle_neighborhood_only") : ("flat",)
        for mode in modes
            push!(report["records"],probe(network,mode,output))
            write(output,JSON.json(report));GC.gc()
        end
    end
    report["status"]=all(r->r["status"]=="equations_verified",report["records"]) ? "diagnostic_complete" : "diagnostic_refusals_present"
    report["process_max_rss_bytes"]=Sys.maxrss()
    write(output,JSON.json(report))
end

optional_runtime_file(path)=isfile(path) ? strip(read(path,String)) : nothing

length(ARGS) in (1,2) || error("usage: root_selection.jl output.json [1000,10000,100000]")
run_diagnostic(ARGS[1],length(ARGS)==2 ? parse.(Int,split(ARGS[2],',')) : [1000,10000,100000])
