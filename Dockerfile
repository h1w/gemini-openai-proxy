FROM node:lts-alpine

ENV PORT=80
ENV OAUTH_CALLBACK_PORT=8085

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE ${PORT}
# OAUTH_CALLBACK_PORT (8085) is only needed when completing OAuth via a
# browser. If you use the Telegram bot paste-URL flow, you do not have to
# publish this port.
EXPOSE ${OAUTH_CALLBACK_PORT}

CMD ["npm", "start"]