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
  return {
    url: `${host}/datasets/${dataset}`,
    http: {
      headers: {
        "x-api-key": assertNotNull(
          process.env.SQD_API_KEY,
          "SQD_API_KEY is not set — the shared Portal endpoint is authenticated"
        ),
      },
    },
  };
}
