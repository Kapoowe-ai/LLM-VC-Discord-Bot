FROM node:20-alpine
WORKDIR /app
COPY . .
RUN apk add --no-cache ffmpeg
RUN npm install --production
CMD ["node", "./index.cjs"]
