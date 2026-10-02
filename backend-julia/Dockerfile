# Используем официальный образ Julia
FROM julia:1.10.12@sha256:238c8f5760477abfc0c8fd2828bbcbfa2a7f5510d11a26f1884a2fbfdb28b365

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы проекта из локальной директории в образ
COPY Project.toml Manifest.toml ./

# Dependencies are cached independently of model/solver source changes.
RUN JULIA_PKG_PRECOMPILE_AUTO=0 julia --project --eval "using Pkg; Pkg.instantiate()"
COPY src ./src
RUN julia --project --eval "using Pkg; Pkg.precompile()"

# Копируем остальные файлы проекта (пакет EnersyCompute, тесты, точка входа)
COPY . .

# Точка входа сервера — отдельный файл: импорт пакета сервер не поднимает
CMD ["julia", "--project=.", "server/main.jl"]
