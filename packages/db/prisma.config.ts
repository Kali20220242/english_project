import "dotenv/config";

import { defineConfig } from "prisma/config";

const url =
  process.env.DIRECT_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/neontalk";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url
  }
});
