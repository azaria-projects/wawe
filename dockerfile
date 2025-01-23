FROM node:20-alpine

WORKDIR /wawe

COPY package.json yarn.lock ./

RUN yarn install

COPY . .

CMD ["node", "app.js"]