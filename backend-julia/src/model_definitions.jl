"""Read-only descriptions of existing implementations, not selectable ModelBindings.
The diagrams describe symbolic structure; they are not a compiled study or a result.
"""
function model_definitions_json()
    files = sort([replace(relpath(joinpath(root, file), @__DIR__), '\\' => '/')
                  for (root, _, names) in walkdir(@__DIR__) for file in names if endswith(file, ".jl")])
    sources = [Dict("path" => "backend-julia/src/" * path,
                    "sha256" => bytes2hex(sha256(read(joinpath(@__DIR__, path))))) for path in files]
    revision = bytes2hex(sha256(join([s["path"] * ":" * s["sha256"] for s in sources], "\n")))
    node(id, label, x, y; terminal=0) = Dict("id" => id, "label" => label, "x" => x, "y" => y, "terminal" => terminal)
    function edge(id, from, to, kind, label; symbol=nothing)
        data = Dict("id" => id, "from" => from, "to" => to, "kind" => kind, "label" => label)
        symbol === nothing || (data["symbol"] = symbol)
        return data
    end
    entry(id, code, name, implementation, equations, limitations, nodes, edges) = Dict(
        "id" => id, "equipment_type" => code, "name" => name, "implementation" => implementation,
        "equations" => equations, "limitations" => limitations, "nodes" => nodes, "edges" => edges,
        "parameters" => model_parameters(code))
    definitions = [
        entry("enersy.ac.source-impedance", "generator", "Источник за последовательным импедансом", "models.jl: generator_model / source_spec",
            ["E_pu∠δ = V_pu + Z_pu I_pu", "Z_pu получается из r + jx (Ом/фазу) на явном базисе; E задаётся в линейных RMS кВ; угол: градусы"],
            ["Симметричный установившийся AC-режим; без динамики машины и регуляторов.",
             "Внутренний узел источника отделён от внешнего терминала. top и bottom — алиасы одного внешнего терминала.",
             "Опорный источник выбирается по правилам острова; остальные источники работают как PV с возможным переходом в PQ при ограничениях Q."],
            [node("external", "Внешний терминал", 60, 65; terminal=1), node("emf", "Узел ЭДС", 240, 65), node("reference", "Опорный потенциал", 240, 165)],
            [edge("z", "external", "emf", "impedance", "r + jx"), edge("e", "emf", "reference", "source", "E∠δ")]),
        entry("enersy.ac.line-pi", "transmission_line", "π-модель линии", "models.jl: line_model",
            ["Z = (r0 + jx0) · L / n", "Y/2 = (g0 + jb0) · L · n / 2", "r0, x0: Ом/км; g0, b0: См/км; L: км; n: число цепей"],
            ["Симметричный установившийся AC-режим; без распределённых параметров и волновых процессов.", "Ветви наполнения относятся к опорному потенциалу AC-представления, а не к добавленному физическому заземлителю."],
            [node("from", "Начало", 60, 65; terminal=1), node("to", "Конец", 300, 65; terminal=2), node("ref1", "Опорный потенциал", 60, 165), node("ref2", "Опорный потенциал", 300, 165)],
            [edge("z", "from", "to", "impedance", "Z"), edge("y1", "from", "ref1", "admittance", "Y/2"), edge("y2", "to", "ref2", "admittance", "Y/2")]),
        entry("enersy.ac.transformer-2w", "transformer", "Двухобмоточный трансформатор", "models.jl: transformer_model / stamp! / branch_flow",
            ["r_own = p_kz / S_nom; z_own = u_kz / 100; x_own = √(z_own² − r_own²)",
             "Zк = (r_own + jx_own) · U_ВН² / S_nom (Ом/фазу, приведено к ВН)",
             "g_own = p_xx / S_nom; y_own = i_xx / 100; Y₀ = (g_own − j√(y_own² − g_own²)) · S_nom / U_ВН² (См/фазу)",
             "k = U_НН / U_ВН > 0; t = k·exp(jφ); φ = phase_shift_deg; на холостом ходу V₂ = tV₁, положительный φ — опережение НН",
             "I₁ = Y₀V₁ + (V₁ − V₂/t)/Zк; I₂ = −(V₁ − V₂/t)/(conj(t)Zк); уравнения для фазоров напряжений на фазу",
             "S_nom: трёхфазные МВА; p_kz, p_xx: трёхфазные МВт; паспортные U: линейные RMS кВ; u_kz, i_xx: %"],
            ["Симметричный установившийся AC; T1 — ВН, T2 — НН независимо от координат, вращения и направления рисования связи.",
             "Ветвь намагничивания отнесена к ВН; при p_xx=i_xx=0 не учитывается с записью допущения. Насыщение и динамика магнитопровода не моделируются.",
             "Модуль коэффициента положительный; фазосдвиг задаётся явно, не выводится из группы соединения. РПН, нейтраль и токи нулевой последовательности этой реализацией не определяются.",
             "Это описание существующей модели, не выбор нового замещения и не поддержка трёхобмоточных, расщеплённых или автотрансформаторов."],
            [node("hv", "ВН", 35, 65; terminal=1), node("series", "После Zк", 170, 65), node("lv", "НН", 325, 65; terminal=2), node("reference", "Опора AC", 35, 170)],
            [edge("z", "hv", "series", "impedance", "Zк"), edge("ratio", "series", "lv", "transformer", "1:k ∠φ"), edge("magnetizing", "hv", "reference", "admittance", "Y₀")]),
        entry("enersy.ac.load-static", "load", "Статическая нагрузка PQ / ZIP", "load_profiles.jl / calculate.jl: power_flow_setup",
            ["PQ (по умолчанию): Sпотр = P + jQ", "ZIP: P(U)=Pном·(p_z·u²+p_i·u+p_p), Q(U)=Qном·(q_z·u²+q_i·u+q_p), u=U/voltage_nom", "Доли Z/I/P для P и Q независимы и каждая тройка суммируется в 1; все шесть долей задаются явно", "P, Q: полные трёхфазные МВт/Мвар; в узловой баланс входят с отрицательным знаком"],
            ["Симметричный установившийся AC-режим; без динамики, частотной зависимости, отключения по напряжению и модели двигателя.", "ZIP выбирается только явно через zip_enabled=true и требует voltage_nom; прежние нагрузки остаются PQ. Постоянный ток означает постоянный модуль при соответствующей доле мощности, а не фиксированный фазор тока."],
            [node("external", "Внешний терминал", 180, 55; terminal=1), node("reference", "Опорный потенциал", 180, 165)],
            [edge("pq", "external", "reference", "pq", "S(U)")]),
    ]
    for (code, name, sign) in (("capacitor", "Ёмкостный AC-шунт", "+"), ("reactor", "Индуктивный AC-шунт", "−"))
        equations = ["B_pu = (Q_nom / S_base) · (V_base / U_nom)²", "Y_pu = " * sign * "jB_pu", "Q_выдачи = " * sign * "Q_nom · (U / U_nom)²; Q_nom: полная трёхфазная Мвар; U, U_nom: линейные RMS кВ", "U_nom — собственное voltage_nom шунта; только при отсутствии используется известный номинал узла с записью допущения"]
        code == "reactor" && push!(equations, "X_L,pu = 1/B_pu при q_nom > 0; q_nom = 0 означает нулевую проводимость (разрыв ветви), не нулевое X_L.")
        push!(definitions, entry("enersy.ac.shunt-" * code, code, name, "models.jl: shunt_model / topology.jl: compile_network",
            equations,
            ["Симметричная постоянная проводимость; активные потери равны нулю. Это не источник постоянной Q.",
             "Один внешний терминал; опорный потенциал AC-модели не является выведенной нейтралью или заземляющим устройством.",
             "Схема Y/Δ/Z, режим нейтрали, токи нулевой последовательности, насыщение и переходные процессы этой моделью не определяются.",
             "q_nom = 0 даёт нулевой вклад с записью допущения; отсутствие q_nom отклоняется компилятором."],
            [node("external", "Внешний терминал", 180, 55; terminal=1), node("reference", "Опорный потенциал AC", 180, 165)],
            [edge("y", "external", "reference", code == "reactor" ? "impedance" : "admittance", code == "reactor" ? "jX_L" : sign * "jB"; symbol=code == "reactor" ? "inductor" : "capacitor")]))
    end
    return Dict("schema_version" => 3, "kernel_version" => VERSION, "source_revision" => revision,
        "source_files" => sources, "model_group" => "three-phase", "method" => "newton-raphson",
        "status" => capability_status_string(capability("three-phase", "newton-raphson").status),
        "definitions" => definitions)
end
