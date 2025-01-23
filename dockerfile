FROM node:20-alpine

WORKDIR /wawe

COPY package.json yarn.lock ./

RUN yarn install --production

COPY . .

CMD ["yarn", "start"]