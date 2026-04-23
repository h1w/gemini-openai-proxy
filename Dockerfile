FROM node:lts-alpine

ENV PORT=80
ENV OAUTH_CALLBACK_PORT=8085

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE ${PORT}
EXPOSE ${OAUTH_CALLBACK_PORT}

CMD ["npm", "start"]