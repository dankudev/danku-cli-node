import { z } from "zod";

export const cloudflareSchema = z.object({
	accountId: z.string().min(1),
	token: z.string().min(1),
	zoneId: z.string().min(1)
});

export const gitHubSchema = z.object({
	token: z.string().min(1)
});

export const marketingBoilerplateSchema = z.object({
	postHogApiKey: z.string().min(1)
});

export const saasFullStackBoilerplateSchema = z.object({
	postHogApiKey: z.string().min(1),
	stripePublishableKey: z.string().min(1),
	stripePublishableKeyDev: z.string().min(1),
	stripeSecretKey: z.string().min(1),
	stripeSecretKeyDev: z.string().min(1),
	stripeWebhookSecret: z.string().min(1)
});

export const boilerplateSchema = z
	.object({
		marketing: marketingBoilerplateSchema.optional(),
		saasFs: saasFullStackBoilerplateSchema.optional()
	})
	.superRefine((target, context) => {
		const configuredBoilerplates = Object.values(target).filter((config) => config !== undefined);

		if (configuredBoilerplates.length > 1) {
			context.addIssue({
				code: "custom",
				message: "Only one boilerplate can be configured at a time",
				path: []
			});
		}
	});

export const deploymentTargetSchema = z
	.object({
		cloudflare: cloudflareSchema.optional()
	})
	.superRefine((target, context) => {
		const configuredDeploymentTargets = Object.values(target).filter(
			(config) => config !== undefined
		);

		if (configuredDeploymentTargets.length === 0) {
			context.addIssue({
				code: "custom",
				message: "At least one target platform must be configured",
				path: []
			});
		}

		if (configuredDeploymentTargets.length > 1) {
			context.addIssue({
				code: "custom",
				message: "Only one target platform can be configured at a time",
				path: []
			});
		}
	});

export const gitProviderSchema = z
	.object({
		gitHub: gitHubSchema.optional()
	})
	.superRefine((target, context) => {
		const configuredGitProviders = Object.values(target).filter((config) => config !== undefined);

		if (configuredGitProviders.length === 0) {
			context.addIssue({
				code: "custom",
				message: "At least one Git provider must be configured",
				path: []
			});
		}

		if (configuredGitProviders.length > 1) {
			context.addIssue({
				code: "custom",
				message: "Only one Git provider can be configured at a time",
				path: []
			});
		}
	});

export const configSchema = z.object({
	boilerplate: boilerplateSchema,
	deploymentTarget: deploymentTargetSchema,
	gitProvider: gitProviderSchema
});

export type Config = z.infer<typeof configSchema>;
