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
  // The Portal key, and ONLY the Portal key: SQD_PORTAL_API_KEY (SSM
  // `ops-param-sqd-portal-api-key`).
  //
  // SQUID_API_KEY used to be read here as a fallback and must not be again. It is the v2 ARCHIVE
  // key, a different SQD product; it held a Portal key only while the two shared one parameter,
  // which is why the fallback looked harmless. It is now demonstrably wrong: the trades squid, whose
  // services still map that variable alone, sent it to this endpoint on deploy and got `403` on
  // every batch. This squid cannot fall back to the public Portal either — its Polygon filter is
  // over the 256 KiB cap — so a missing key has to fail loudly here rather than 403 later, where the
  // cause is far less obvious.
  const apiKey = process.env.SQD_PORTAL_API_KEY;
  return {
    url: `${host}/datasets/${dataset}`,
    http: {
      headers: {
        "x-api-key": assertNotNull(
          apiKey,
          "SQD_PORTAL_API_KEY is not set — the shared Portal endpoint is authenticated"
        ),
      },
    },
  };
}
