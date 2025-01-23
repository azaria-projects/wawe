FROM node:20-alpine

WORKDIR /wawe

COPY . .

RUN yarn install

CMD ["node", "app.js"]