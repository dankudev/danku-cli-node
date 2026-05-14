import { PUBLIC_ORIGIN } from "$env/static/public";
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async () => {
	const robots = `User-agent: *
Allow: /
Disallow: /app/

Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`;

	return new Response(robots, {
		headers: {
			"Content-Type": "text/plain"
		}
	});
};
