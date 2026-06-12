<script lang="ts">
    import { PUBLIC_ORIGIN } from "$env/static/public";
    import faviconSvg from "$lib/assets/favicon.svg";
    import faviconIco from "$lib/assets/favicon.ico";
	import { page } from "$app/state";
	import "./layout.css";
	
	let { children } = $props();
</script>

<svelte:head>
	<meta property="og:url" content={PUBLIC_ORIGIN + page.url.pathname} />
	<link rel="canonical" href={PUBLIC_ORIGIN + page.url.pathname} />
	<meta property="og:description" content={page.data.description} />
	<meta property="og:image" content={PUBLIC_ORIGIN + "/og.png"} />
	<meta name="description" content={page.data.description} />
	<link rel="icon" href={faviconSvg} type="image/svg+xml" />
	<meta property="og:title" content={page.data.title} />
	<link rel="icon" href={faviconIco} sizes="32x32" />
	<meta property="og:type" content="website" />
	<title>{page.data.title}</title>
</svelte:head>

{@render children?.()}
