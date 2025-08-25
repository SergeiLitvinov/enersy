# Используем официальный образ Julia
FROM julia:1.10

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы проекта из локальной директории в образ
COPY Project.toml ./

# Устанавливаем зависимости через Julia Package Manager
RUN julia --project --eval "using Pkg; Pkg.instantiate()"

# Копируем остальные файлы проекта (если есть)
COPY . .

# Задаем команду для запуска приложения (например, ваш скрипт)
CMD ["julia", "--project=.", "main.jl"]