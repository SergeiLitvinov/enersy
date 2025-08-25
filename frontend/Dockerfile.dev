FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install

# Копируем остальные файлы
COPY . .

# Публикуем порт
EXPOSE 3000

# Запускаем Vite в режиме разработки
CMD ["npm", "run", "dev"]