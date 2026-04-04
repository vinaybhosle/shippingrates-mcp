FROM node:20-slim
RUN npm install -g mcp-remote
CMD ["npx", "mcp-remote", "https://mcp.shippingrates.org/mcp"]
