# Используем официальный образ Julia
FROM julia:1.13.2@sha256:3974efa4758e60a1a30d0bed2c9bb64c002eb5e231a7f6ea6de73f78433073b3 AS notice-input-runtime

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы проекта из локальной директории в образ
COPY backend-julia/Project.toml backend-julia/Manifest.toml ./

# Dependencies are cached independently of model/solver source changes.
RUN JULIA_PKG_PRECOMPILE_AUTO=0 julia --project --eval 'using Pkg; originals = Dict(file => read(file) for file in ("Project.toml", "Manifest.toml")); Pkg.instantiate(); all(read(file) == bytes for (file, bytes) in originals) || error("Pkg.instantiate modified the locked project")'
COPY backend-julia/src ./src
RUN julia --project --eval "using Pkg; Pkg.precompile()"

# Копируем остальные файлы проекта (пакет EnersyCompute, тесты, точка входа)
COPY backend-julia/ .
COPY LICENSE /usr/share/licenses/enersy/LICENSE

# Maintenance can inspect a new SDK before refreshing its reviewed notice index.
# The default application image always runs the notice verification below.
FROM notice-input-runtime
COPY scripts/security/julia-notices /usr/share/licenses/enersy/julia-notice-sources
COPY scripts/security/julia-notices/runtime/THIRDPARTY.md /usr/local/julia/THIRDPARTY.md
COPY scripts/security/collect_julia_licenses.jl scripts/security/test_collect_julia_licenses.jl scripts/security/julia-notice-sources.json /notice-tools/
RUN --network=none julia --project=. --startup-file=no /notice-tools/collect_julia_licenses.jl /usr/share/licenses/enersy/julia-notice-sources /notice-tools/julia-notice-sources.json /usr/share/licenses/enersy/julia-modules.json

# Точка входа сервера — отдельный файл: импорт пакета сервер не поднимает
CMD ["julia", "--project=.", "server/main.jl"]
