# backend-julia/main.jl
using HTTP, JSON3

function handler(req::HTTP.Request)
    try
        if HTTP.method(req) == "POST" && HTTP.path(req) == "/solve"
            body = String(HTTP.payload(req))
            data = JSON3.read(body)
            A = Matrix{Float64}(data["A"])
            b = Vector{Float64}(data["b"])
            x = A \ b
            return HTTP.Response(200, JSON3.write(Dict("solution" => x)))
        elseif HTTP.method(req) == "GET" && HTTP.path(req) == "/health"
            return HTTP.Response(200, "OK")
        else
            return HTTP.Response(404, "Not Found")
        end
    catch e
        return HTTP.Response(500, "Error: $(e)")
    end
end

port = parse(Int, get(ENV, "PORT", "8001"))
HTTP.serve(handler, "0.0.0.0", port)