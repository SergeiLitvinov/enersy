using Test, EnersyCompute, SparseArrays, Libdl
include(joinpath(@__DIR__, "..", "experimental", "RustJacobian.jl"))
const RJ = RustJacobianAdapter
const EC = EnersyCompute
const LIBRARY = get(ENV, "ENERSY_NUMERICS_LIBRARY", "/opt/enersy/libenersy_numerics.so")

@testset "Julia/Rust ABI, scope ownership and invalid inputs" begin
    @test sizeof(RJ.Input{UInt64}) == 16
    @test sizeof(RJ.Output{Float64}) == 16
    @test sizeof(RJ.Info) == 24
    @test sizeof(RJ.Demand) == 40
    @test fieldoffset(RJ.Demand, 2) == 8
    @test fieldoffset(RJ.Demand, 5) == 32
    wrong = get(ENV, "ENERSY_WRONG_ABI_LIBRARY", "/opt/enersy/libwrong_abi.so")
    mismatch = try RJ.with_library(_ -> error("wrong ABI callback must not run"), wrong) catch e; e end
    @test mismatch isa RJ.NativeError && mismatch.code == :abi_mismatch
    @test !any(path -> endswith(path, "libwrong_abi.so"), Libdl.dllist())
    Y = sparse(ComplexF64[1 -1; -1 1])
    setup = EC.PowerFlowSetup(2,1,1.0,0.0,Int[],[2],Float64[],Float64[],[-0.2],[0.0])
    v, theta = [1.0,0.8], zeros(2)
    powers = EC.bus_powers(Y,v,theta)
    old_plan, old_library = Ref{Any}(), Ref{Any}()
    result = RJ.with_library(LIBRARY) do library
        old_library[] = library
        @test RJ.live_plans(library) == 0
        matrix = RJ.with_plan(library,Y,setup) do plan
            old_plan[] = plan
            @test RJ.live_plans(library) == 1
            J = RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,setup)
            @test Matrix(J) ≈ [0.0 0.6; -0.8 0.0] atol=1e-12
            baseline = copy(J)
            bad = try RJ.assemble(plan,Y,[1.0,NaN],theta,powers.P,powers.Q,setup) catch e; e end
            @test bad isa RJ.NativeError && bad.status == 4
            changed = copy(Y); changed.rowval[1] = 2
            bad = try RJ.assemble(plan,changed,v,theta,powers.P,powers.Q,setup) catch e; e end
            @test bad isa RJ.NativeError && bad.code == :pattern_changed
            pv_setup = EC.PowerFlowSetup(2,1,1.0,0.0,[2],Int[],[0.8],[-0.16],Float64[],Float64[])
            bad = try RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,pv_setup) catch e; e end
            @test bad isa RJ.NativeError && bad.code == :layout_changed
            child = @async try RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,setup) catch e; e end
            bad = fetch(child)
            @test bad isa RJ.NativeError && bad.code == :wrong_task
            child_plan = @async try RJ.with_plan(_ -> error("foreign callback must not run"),library,Y,setup) catch e; e end
            bad = fetch(child_plan)
            @test bad isa RJ.NativeError && bad.code == :wrong_task
            @test RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,setup) == baseline
            @test J == baseline
            J
        end
        @test RJ.live_plans(library) == 0
        bad = try RJ.assemble(old_plan[],Y,v,theta,powers.P,powers.Q,setup) catch e; e end
        @test bad isa RJ.NativeError && bad.code == :closed_plan
        for _ in 1:50
            @test_throws ErrorException RJ.with_plan(_ -> error("callback failure"),library,Y,setup)
        end
        @test RJ.live_plans(library) == 0
        matrix
    end
    GC.gc()
    @test Matrix(result) ≈ [0.0 0.6; -0.8 0.0] atol=1e-12
    bad = try RJ.live_plans(old_library[]) catch e; e end
    @test bad isa RJ.NativeError && bad.code == :closed_library
    bad = try RJ.with_plan(_ -> error("closed callback must not run"),old_library[],Y,setup) catch e; e end
    @test bad isa RJ.NativeError && bad.code == :closed_library
end

@testset "FFI singleton accepts empty input and output buffers" begin
    Y = spzeros(ComplexF64,1,1)
    setup = EC.PowerFlowSetup(1,1,1.0,0.0,Int[],Int[],Float64[],Float64[],Float64[],Float64[])
    RJ.with_library(LIBRARY) do library
        J = RJ.with_plan(library,Y,setup) do plan
            RJ.assemble(plan,Y,[1.0],[0.0],[0.0],[0.0],setup)
        end
        @test size(J) == (0,0)
        @test nnz(J) == 0
        @test RJ.live_plans(library) == 0
    end
end

@testset "FFI mixed PV/PQ, phase coupling, ZIP and numeric updates" begin
    Y = sparse(ComplexF64[2-5im -0.8+1.5im -0.4+2.7im; -0.3+1.1im 0 -0.9+0.8im; -0.7+2.3im -0.5+2im 1.8-4im])
    # Remove a non-slack diagonal; arbitrary ordering matches safe Rust tests.
    Y[1,1] = 0; dropzeros!(Y)
    demands = [EC.VoltageDemand(1,0.2,0.3,-0.05,0.1),EC.VoltageDemand(1,0.1,0.2,0.04,0.2)]
    setup = EC.PowerFlowSetup(3,2,1.03,0.03,[3],[1],[1.01],[0.0],[0.0],[0.0];voltage_demands=demands)
    RJ.with_library(LIBRARY) do library
        RJ.with_plan(library,Y,setup) do plan
            for (v,theta) in [([0.97,1.03,1.01],[-0.11,0.03,0.09]),([1.1,0.99,0.93],[0.2,-0.1,-0.17])]
                powers = EC.bus_powers(Y,v,theta)
                expected = EC.jacobian(Y,v,theta,powers.P,powers.Q,setup)[1]
                @test maximum(abs,RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,setup)-expected) < 1e-11
            end
            Y.nzval .*= 1.1
            v, theta = [1.0,1.03,0.99],[-0.05,0.03,0.07]
            powers = EC.bus_powers(Y,v,theta)
            @test maximum(abs,RJ.assemble(plan,Y,v,theta,powers.P,powers.Q,setup)-EC.jacobian(Y,v,theta,powers.P,powers.Q,setup)[1]) < 1e-11
        end
        @test RJ.live_plans(library) == 0
    end
end
