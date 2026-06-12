import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

let dbInstance: DrizzleD1Database | null = null;

export function getOrCreateDb(env: Env): DrizzleD1Database {
	if (!dbInstance) {
		dbInstance = drizzle(env.DB);
	}

	return dbInstance;
}
