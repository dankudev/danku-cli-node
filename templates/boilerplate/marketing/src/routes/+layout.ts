import { PUBLIC_POSTHOG_API_KEY } from "$env/static/public";
import { browser, dev } from "$app/environment";
import posthog from "posthog-js";

import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async () => {
    if (browser && PUBLIC_POSTHOG_API_KEY) {
        posthog.init(PUBLIC_POSTHOG_API_KEY, {
            api_host: "https://us.i.posthog.com",
            custom_campaign_params: ["ref"],
            defaults: "2026-01-30",
            ui_host: 'https://us.posthog.com'
        });
    }
};

export const prerender = !dev;
