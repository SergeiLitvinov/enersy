# Используем официальный образ Julia
FROM julia:1.10

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы проекта из локальной директории в образ
COPY Project.toml Manifest.toml ./
COPY src ./src

# Устанавливаем зависимости через Julia Package Manager
RUN julia --project --eval "using Pkg; Pkg.instantiate(); Pkg.precompile()"

# Копируем остальные файлы проекта (пакет EnersyCompute, тесты, точка входа)
COPY . .

# Точка входа сервера — отдельный файл: импорт пакета сервер не поднимает
CMD ["julia", "--project=.", "server/main.jl"]
