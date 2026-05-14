import { AUTH_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "$env/static/private";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getLeastLoadedShardNumber } from "./db/shards";
import { PUBLIC_ORIGIN } from "$env/static/public";
import { getRequestEvent } from "$app/server";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import * as schema from "./db/schema";
import { getOrCreateDb } from "./db";
import Stripe from "stripe";

const stripeClient = new Stripe(STRIPE_SECRET_KEY);

const createAuth = (db: DrizzleD1Database) =>
	betterAuth({
		baseURL: PUBLIC_ORIGIN,
		secret: AUTH_SECRET,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema: schema,
			usePlural: true
		}),
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						return {
							data: {
								...user,
								shardId: getLeastLoadedShardNumber(getRequestEvent().platform!.env)
							}
						};
					}
				}
			}
		},
		plugins: [
			stripe({
				createCustomerOnSignUp: true,
				stripeClient,
				stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
				subscription: {
					enabled: true,
					plans: []
				}
			}),
			sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
		],
		user: {
			additionalFields: {
				shardId: {
					input: false,
					required: true,
					type: "number"
				}
			}
		}
	});

let authInstance: ReturnType<typeof createAuth> | null = null;

export function getOrCreateAuth(env: Env) {
	if (!authInstance) {
		authInstance = createAuth(getOrCreateDb(env));
	}

	return authInstance!;
}

export type User = ReturnType<typeof createAuth>["$Infer"]["Session"]["user"];
