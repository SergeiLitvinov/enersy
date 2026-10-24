# Optional Docker worker. No request can choose the module/library path.
using EnersyCompute, HTTP
include("RustJacobian.jl")
include(joinpath(@__DIR__,"..","server","main.jl"))

function main()
    path = get(ENV,"ENERSY_NUMERICS_LIBRARY","/opt/enersy/libenersy_numerics.so")
    backends = (EnersyCompute.julia_backend(), RustJacobianAdapter.native_backend(path))
    server = EnersyCompute.start_server(; host=get(ENV,"HOST","0.0.0.0"),
        port=EnersyServer.port_from_env(), backends)
    try
        wait(server)
    finally
        HTTP.forceclose(server)
    end
end
abspath(PROGRAM_FILE) == (@__FILE__) && main()
