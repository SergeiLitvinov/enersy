using HTTP, JSON3

function handler(req::HTTP.Request)
    try
        if req.method == "POST" && req.target == "/solve"
            body = String(req.body)

            if isempty(body)
                return HTTP.Response(400, JSON3.write(Dict("error" => "Empty request body")))
            end

            data = JSON3.read(body)

            if !haskey(data, "A") || !haskey(data, "b")
                return HTTP.Response(400, JSON3.write(Dict("error" => "Missing 'A' or 'b'")))
            end

            # Преобразуем A: из вложенного массива в Matrix{Float64}
            A = try
                rows = data["A"]
                if !all(isa(row, AbstractArray) && all(isa(x, Number) for x in row) for row in rows)
                    throw(ArgumentError("All rows of A must be numeric arrays"))
                end

                float_rows = [Float64.(row) for row in rows]
                len = length(float_rows[1])
                if any(length(row) != len for row in float_rows)
                    throw(ArgumentError("All rows in A must have the same length"))
                end

                Matrix{Float64}(reduce(hcat, float_rows)')
            catch
                return HTTP.Response(400, JSON3.write(Dict("error" => "Invalid matrix A")))
            end

            # Преобразуем b в Vector{Float64}
            b = try
                vec_data = data["b"]
                if !(isa(vec_data, AbstractArray) && all(isa(x, Number) for x in vec_data))
                    throw(ArgumentError("b must be a numeric array"))
                end
                Float64.(vec_data)
            catch
                return HTTP.Response(400, JSON3.write(Dict("error" => "Invalid vector b")))
            end

            # Проверяем совместимость размеров
            if size(A, 2) != length(b)
                return HTTP.Response(400, JSON3.write(Dict("error" => "Dimensions do not match")))
            end

            # Решаем систему Ax = b
            x = A \ b

            # Возвращаем результат
            return HTTP.Response(200,
                ["Content-Type" => "application/json"],
                body=JSON3.write(Dict("solution" => x))
            )

        elseif req.method == "GET" && req.target == "/health"
            return HTTP.Response(200, "OK")

        else
            return HTTP.Response(404,
                ["Content-Type" => "application/json"],
                body=JSON3.write(Dict("error" => "Not Found"))
            )
        end
    catch
        return HTTP.Response(500,
            ["Content-Type" => "application/json"],
            body=JSON3.write(Dict("error" => "Internal Server Error"))
        )
    end
end

# Запуск сервера
port = parse(Int, get(ENV, "PORT", "8001"))
HTTP.serve(handler, "0.0.0.0", port)