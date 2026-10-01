#!/usr/bin/env julia
# Compatibility launcher. The implementation lives in EnersyCompute.
if abspath(PROGRAM_FILE) == @__FILE__
    include(joinpath(@__DIR__, "server", "main.jl"))
    EnersyServer.main()
end
