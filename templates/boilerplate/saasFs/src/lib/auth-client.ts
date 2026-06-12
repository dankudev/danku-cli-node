import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/svelte";
import posthog from "posthog-js";

export const auth = createAuthClient({
	fetchOptions: {
		onError: (error) => {
			posthog.captureException(error.error);
		}
	},
	plugins: [
		stripeClient({
			subscription: true
		})
	]
});
