export type Config = {
	boilerplate: {
		marketing?: {
			postHogApiKey: string;
		};
		saasFs?: {
			postHogApiKey: string;
			stripePublishableKey: string;
			stripePublishableKeyDev: string;
			stripeSecretKey: string;
			stripeSecretKeyDev: string;
			stripeWebhookSecret: string;
		};
	};
	deploymentTarget: {
		cloudflare?: {
			accountId: string;
			token: string;
			zoneId: string;
		};
	};
	gitProvider: {
		gitHub?: {
			token: string;
		};
	};
};
