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
  http: { retryAttempts: number; headers: Record<string, string> };
} {
  const host = process.env.SQD_PORTAL_URL || DEFAULT_PORTAL_HOST;
  // The Portal now has its own key variable, and reading ONLY that one is the point of this function.
  //
  // It used to fall back to SQUID_API_KEY, which is the variable wired to every squid for the v2
  // archive (`setGateway({ apiKey })`, still how the trades squid ingests). Those are two products
  // with two keys, so once the archive key went back into that parameter the fallback stopped being
  // a safety net and became a trap: the Portal answers 403 to a wrong key exactly as it does to no
  // key, so falling back would authenticate with the archive key and fail on every request, at
  // runtime, without saying why. Missing configuration should stop the boot instead.
  return {
    url: `${host}/datasets/${dataset}`,
    http: {
      // Never give up on a Portal hiccup. A 503 here is a transient: it is what the Portal answers
      // while a freshly added chunk is still replicating to its workers, so the data is fine and a
      // later attempt succeeds. Exhausting the budget instead kills the processor, ECS replaces the
      // task, and a replacement task is what triggers a full re-index, which is hours of work to
      // survive a transient that lasted a minute. Waiting forever is strictly cheaper.
      //
      // Needs portal-client >= 0.7.0: until then `request()` overrode this with a hardcoded 6, so
      // the option looked set and did nothing.
      retryAttempts: Infinity,
      headers: {
        "x-api-key": assertNotNull(
          process.env.SQD_PORTAL_API_KEY,
          "SQD_PORTAL_API_KEY is not set — the shared Portal endpoint is authenticated"
        ),
      },
    },
  };
}
