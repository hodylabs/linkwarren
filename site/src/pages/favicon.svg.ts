import svg from "../../../design/logo/linkwarren-mark.svg?raw";

// The favicon is the logo from design/logo, bundled at build time so there is only one copy of it.
export const GET = () => new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
