module RustJacobianAdapter
using Libdl, SparseArrays, EnersyCompute
const EC = EnersyCompute
const ABI_VERSION = UInt32(1)

struct NativeError <: Exception
    code::Symbol
    status::Int32
    message::String
end
Base.showerror(io::IO, error::NativeError) = print(io, error.code, ": ", error.message, " (status=", error.status, ")")
fail(code, message; status=Int32(0)) = throw(NativeError(code, status, message))
check(status::Int32) = status == 0 ? nothing : fail(:native_error, "Rust Jacobian operation failed"; status)

struct Input{T}
    data::Ptr{T}
    len::UInt64
end
struct Output{T}
    data::Ptr{T}
    len::UInt64
end
Input(values::Vector{T}) where T = Input{T}(pointer(values), UInt64(length(values)))
Output(values::Vector{T}) where T = Output{T}(pointer(values), UInt64(length(values)))
struct Info
    handle::UInt64
    dimension::UInt64
    nonzeros::UInt64
end
struct Demand
    bus::UInt64
    p_i::Float64
    p_z::Float64
    q_i::Float64
    q_z::Float64
end
mutable struct NativeLibrary{F}
    handle::Ptr{Cvoid}
    functions::F
    lock::ReentrantLock
    owner::Task
    closed::Bool
end
mutable struct Plan{L}
    library::L
    handle::UInt64
    owner::Task
    dimension::Int
    columns::Vector{Int}
    rows::Vector{Int}
    y_columns::Vector{Int}
    y_rows::Vector{Int}
    pv::Vector{Int}
    pq::Vector{Int}
    slack::Int
end
function ensure_open(library)
    library.closed && fail(:closed_library, "Native library scope has ended")
    current_task() === library.owner || fail(:wrong_task, "Library scope belongs to another task")
end

"""Load only an operator-selected trusted native library. Synchronous lexical
ownership: library closes after the callback; plans must be created with_plan.
No fallback or loading of uploaded model code is provided.
"""
function with_library(operation, path::AbstractString)
    Sys.WORD_SIZE == 64 || fail(:unsupported_platform, "C ABI v1 requires 64-bit Julia")
    sizeof(Input{UInt64}) == 16 && sizeof(Info) == 24 && sizeof(Demand) == 40 || fail(:abi_mismatch, "Julia ABI layout differs")
    handle = Libdl.dlopen(path)
    library = nothing
    try
        version = ccall(Libdl.dlsym(handle, :enersy_numerics_abi_version), UInt32, ())
        version == ABI_VERSION || fail(:abi_mismatch, "Expected ABI 1, received $version")
        functions = (; create=Libdl.dlsym(handle, :enersy_jacobian_create_v1), pattern=Libdl.dlsym(handle, :enersy_jacobian_pattern_v1),
            update=Libdl.dlsym(handle, :enersy_jacobian_update_v1), destroy=Libdl.dlsym(handle, :enersy_jacobian_destroy_v1),
            live=Libdl.dlsym(handle, :enersy_jacobian_live_plans_v1))
        library = NativeLibrary(handle, functions, ReentrantLock(), current_task(), false)
        operation(library)
    finally
        if library === nothing
            Libdl.dlclose(handle)
        else
            lock(library.lock) do
                library.closed = true
                Libdl.dlclose(handle)
            end
        end
    end
end

"""Create a plan owned by this synchronous callback/task; release on every exit.
Returned matrices own Julia arrays and may outlive the plan and library.
"""
function with_plan(operation, library::NativeLibrary, Y::SparseMatrixCSC{ComplexF64,Int}, setup)
    ensure_open(library)
    lock(library.lock) do
        ensure_open(library)
        EC.validate_setup(setup)
        size(Y) == (setup.nbus, setup.nbus) || fail(:invalid_pattern, "Y and setup dimensions differ")
        pv, pq = UInt64.(setup.pv .- 1), UInt64.(setup.pq .- 1)
        columns, rows = UInt64.(Y.colptr .- 1), UInt64.(rowvals(Y) .- 1)
        info = Ref(Info(0,0,0))
        status = GC.@preserve pv pq columns rows info ccall(library.functions.create, Int32,
            (UInt32,UInt64,UInt64,Input{UInt64},Input{UInt64},Input{UInt64},Input{UInt64},Ref{Info}),
            ABI_VERSION, setup.nbus, setup.slack-1, Input(pv), Input(pq), Input(columns), Input(rows), info)
        check(status)
        id = info[].handle
        plan = nothing
        try
            jc, jr = Vector{UInt64}(undef, Int(info[].dimension)+1), Vector{UInt64}(undef, Int(info[].nonzeros))
            status = GC.@preserve jc jr ccall(library.functions.pattern, Int32, (UInt64,Output{UInt64},Output{UInt64}), id, Output(jc), Output(jr))
            check(status)
            plan = Plan(library, id, current_task(), Int(info[].dimension), Int.(jc) .+ 1, Int.(jr) .+ 1,
                copy(Y.colptr), copy(rowvals(Y)), copy(setup.pv), copy(setup.pq), setup.slack)
            operation(plan)
        finally
            status = ccall(library.functions.destroy, Int32, (UInt64,), id)
            plan === nothing || (plan.handle = 0)
            check(status)
        end
    end
end

"""Experimental checked call, including split-complex input copies and owned
CSC output copies. No native pointers escape. Calls from another task or with
changed topology/classification fail instead of silently using a stale plan.
"""
function assemble(plan::Plan, Y::SparseMatrixCSC{ComplexF64,Int}, v::Vector{Float64}, theta::Vector{Float64}, p::Vector{Float64}, q::Vector{Float64}, setup;
                  native_ns::Union{Nothing,Base.RefValue{UInt64}}=nothing)
    current_task() === plan.owner || fail(:wrong_task, "Plan belongs to another task")
    lock(plan.library.lock) do
        plan.handle != 0 || fail(:closed_plan, "Native plan scope has ended")
        ensure_open(plan.library)
        EC.validate_setup(setup)
        setup.slack == plan.slack && setup.pv == plan.pv && setup.pq == plan.pq || fail(:layout_changed, "PV/PQ layout requires a new plan")
        size(Y) == (setup.nbus,setup.nbus) && Y.colptr == plan.y_columns && rowvals(Y) == plan.y_rows || fail(:pattern_changed, "Y pattern requires a new plan")
        g, b = real.(nonzeros(Y)), imag.(nonzeros(Y))
        demands = [Demand(UInt64(d.bus-1),d.p_i,d.p_z,d.q_i,d.q_z) for d in setup.voltage_demands]
        values = Vector{Float64}(undef, length(plan.rows))
        native_ns === nothing || (native_ns[] = 0)
        before = native_ns === nothing ? UInt64(0) : time_ns()
        status = GC.@preserve g b v theta p q demands values ccall(plan.library.functions.update, Int32,
            (UInt64,Input{Float64},Input{Float64},Input{Float64},Input{Float64},Input{Float64},Input{Float64},Input{Demand},Output{Float64}),
            plan.handle, Input(g), Input(b), Input(v), Input(theta), Input(p), Input(q), Input(demands), Output(values))
        native_ns === nothing || (native_ns[] = time_ns() - before)
        check(status)
        SparseMatrixCSC(plan.dimension, plan.dimension, copy(plan.columns), copy(plan.rows), values)
    end
end

function live_plans(library::NativeLibrary)
    ensure_open(library)
    lock(library.lock) do
        ensure_open(library)
        count = Ref{UInt64}(0)
        check(ccall(library.functions.live, Int32, (Ref{UInt64},), count))
        count[]
    end
end
end
