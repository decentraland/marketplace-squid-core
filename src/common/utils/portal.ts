import { assertNotNull } from "@subsquid/util-internal";

const DEFAULT_PORTAL_HOST = "https://shared.portal.sqd.dev";

/**
 * The SQD Network Portal stream this squid ingests from.
 *
 * The SHARED portal, not the public one, and the difference is not cosmetic. A Portal query is
 * capped at 256 KiB, and our Polygon log filter carries the full list of DCL collection addresses
 * — ~260 KB today and growing with every collection published. Over the public endpoint that query
 * is rejected with `400 Query is too large` and the processor never ingests a single block, which
 * is what stalled the Polygon reindex for two weeks. The shared endpoint raises the cap; it is
 * authenticated, so it also needs the key.
 *
 * The host is overridable because the endpoint has already moved once: a replacement should not
 * require shipping new code. The key is env-only and must never be committed.
 */
export function portalSource(dataset: string): {
  url: string;
  http: { headers: Record<string, string> };
} {
  const host = process.env.SQD_PORTAL_URL || DEFAULT_PORTAL_HOST;
  // Today the key arrives as SQUID_API_KEY: that is the variable already wired to every squid
  // service (SSM `ops-param-subsquid-api-key`), and that parameter now holds the Portal key.
  //
  // TRANSITIONAL. The same variable is what the pre-Portal trades squid still passes to the v2
  // archive as `setGateway({ apiKey })`, and those are two different SQD products with two
  // different keys — one parameter cannot serve both. It works today only because a processor at
  // the head reads from the RPC and only falls back to the archive when it drops far behind. Once
  // trades is promoted onto its Portal build it stops needing the archive key entirely; give the
  // Portal its own parameter then and drop the fallback below.
  const apiKey = process.env.SQD_API_KEY || process.env.SQUID_API_KEY;
  return {
    url: `${host}/datasets/${dataset}`,
    http: {
      headers: {
        "x-api-key": assertNotNull(
          apiKey,
          "Neither SQD_API_KEY nor SQUID_API_KEY is set — the shared Portal endpoint is authenticated"
        ),
      },
    },
  };
}
