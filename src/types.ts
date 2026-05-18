export type Config = {
	boilerplate: {
		marketing?: {
			postHogOrganizationId: string;
		};
		saasFs?: {
			postHogOrganizationId: string;
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
			domain: string;
		};
	};
	gitProvider: {
		gitHub?: Record<string, never>;
	};
};
