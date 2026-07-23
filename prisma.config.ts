import "dotenv/config"
import { defineConfig, env } from "prisma/config"

const migrationUrl = process.env.DATABASE_URL ?? ""

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: migrationUrl
    ? { url: migrationUrl }
    : { url: env("DATABASE_URL") },
})
