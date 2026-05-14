import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "./src/lib/server/db/shards/migrations",
    schema: "./src/lib/server/db/shards/schema.ts"
});
