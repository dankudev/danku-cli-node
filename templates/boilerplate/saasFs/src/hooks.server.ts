import { type Handle, type HandleServerError, redirect } from "@sveltejs/kit";
import { PUBLIC_POSTHOG_API_KEY } from "$env/static/public";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { getOrCreateAuth } from "$lib/server/auth";
import { building } from "$app/environment";
import { PostHog } from "posthog-node";

export const handle: Handle = async ({ event, resolve }) => {
	if (building) {
		return resolve(event);
	}

	const auth = getOrCreateAuth(event.platform!.env);
	const session = await auth.api.getSession({
		headers: event.request.headers
	});
	if (session) {
		event.locals.user = session.user;
	}

	if (event.route.id?.includes("(protected)")) {
		if (!event.locals.user) {
			redirect(302, "/app/sign-in");
		}

		const subscriptions = await auth.api.listActiveSubscriptions({
			headers: event.request.headers
		});

		const activeSubscription = subscriptions.find(
			(sub) => sub.status === "trialing" || sub.status === "active"
		);
		if (!activeSubscription) {
			const fixableSubscription = subscriptions.find(
				(sub) => sub.status === "incomplete" || sub.status === "past_due" || sub.status === "unpaid"
			);
			const checkoutSession = await auth.api.upgradeSubscription({
				body: {
					plan: "essential",
					subscriptionId: fixableSubscription?.id,
					successUrl: "/app",
					cancelUrl: "/#pricing",
					disableRedirect: false
				},
				headers: event.request.headers
			});
			redirect(302, checkoutSession.url!);
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handleError: HandleServerError = async ({ error, status, message }) => {
    if (PUBLIC_POSTHOG_API_KEY && status !== 404) {
        const postHogClient = new PostHog(PUBLIC_POSTHOG_API_KEY);
        postHogClient.captureException(error);
        await postHogClient.shutdown();

        return {
            message: `An unhandled server-side error occurred: ${message}`
        };
    }
};
