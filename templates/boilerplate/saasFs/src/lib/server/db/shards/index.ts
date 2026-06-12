import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

const SHARD_BINDING_NAME_PATTERN = /^DB_S(\d{2})$/;

let maxShardNumber: number | null = null;
const shardDbInstances = new Map<number, DrizzleD1Database>();

export function getOrCreateShardDb(env: Env, shardNumber: number): DrizzleD1Database {
	if (maxShardNumber === null) {
		maxShardNumber = Object.keys(env as unknown as Record<string, unknown>).reduce((currentMax, key) => {
			const match = SHARD_BINDING_NAME_PATTERN.exec(key);

			if (!match) {
				return currentMax;
			}

			return Math.max(currentMax, Number.parseInt(match[1], 10));
		}, -1);

		if (maxShardNumber < 0) {
			throw new Error("No shard database bindings were found in the Cloudflare env.");
		}
	}

	if (!Number.isInteger(shardNumber) || shardNumber < 0 || shardNumber > maxShardNumber) {
		throw new RangeError(
			`Shard number must be an integer between 0 and ${maxShardNumber}. Received ${shardNumber}.`
		);
	}

	const existingShardDb = shardDbInstances.get(shardNumber);

	if (existingShardDb) {
		return existingShardDb;
	}

	const shardBindingName = `DB_S${shardNumber.toString().padStart(2, "0")}`;
	const shardBinding = (env as unknown as Record<string, unknown>)[shardBindingName];

	if (!shardBinding) {
		throw new Error(`Shard binding "${shardBindingName}" was not found in the Cloudflare env.`);
	}

	const shardDb = drizzle(shardBinding as D1Database);
	shardDbInstances.set(shardNumber, shardDb);

	return shardDb;
}

export function getLeastLoadedShardNumber(env: Env): number {
    // implement this
    return 0;
}
