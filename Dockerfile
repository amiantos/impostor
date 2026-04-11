FROM node:20

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
