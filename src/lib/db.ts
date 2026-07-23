import "server-only"
import { Pool } from "pg"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/generated/prisma/client"

function createPool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add your Postgres URL (Neon/prod) in .env or the host env panel."
    )
  }

  // Neon and most cloud Postgres need TLS. Local URLs without sslmode stay plain.
  const needsSsl =
    /sslmode=require/i.test(connectionString) ||
    /neon\.tech/i.test(connectionString) ||
    /supabase\.co/i.test(connectionString) ||
    process.env.DATABASE_SSL === "true"

  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: process.env.NODE_ENV === "production" ? 5 : 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
  })
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pgPool: Pool | undefined
}

const pool = globalForPrisma.pgPool ?? createPool()
const adapter = new PrismaPg(pool)

export const db: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db
  globalForPrisma.pgPool = pool
}
