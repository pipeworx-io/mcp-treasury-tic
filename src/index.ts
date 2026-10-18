interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * U.S. Treasury International Capital (TIC) System — foreign holdings of
 * U.S. securities, by country, monthly.
 *
 * FRED does not carry this series (it is a capital-flows survey, not an
 * aggregate macro indicator FRED mirrors), and the gateway's existing
 * treasury-fiscal pack covers the daily fiscal ledger (debt, receipts,
 * customs) — a different Treasury system entirely. TIC is the Bureau of the
 * Fiscal Service's own cross-border capital-flows survey.
 *
 * SHAPE. Treasury publishes TIC's monthly SLT ("Securities Held or
 * Transacted — Long-Term") tables as small tab-delimited text files, not a
 * JSON API — these are the same two tables analysts and the financial press
 * read by hand:
 *
 *   - Table 1 ("U.S. Long-Term Securities Held by Foreign Residents"): every
 *     country, every month back to 2011 or so, broken into Treasury/agency
 *     bond/corporate bond/equity holdings. ~1MB uncompressed.
 *   - The "Major Foreign Holders of Treasury Securities" table: the ~20
 *     largest individual holders plus an "All Other" bucket and the
 *     official-sector split — the number financial press quotes as
 *     "China holds $X of Treasuries." A few KB.
 *
 * Both are small enough to fetch and parse live per request, straight from
 * the publisher on every call — so a mid-month revision shows up immediately
 * and there is no refresh job to maintain.
 *
 * PARSING. Each file is one data block (country/label, then tab-separated
 * numeric columns) followed by a blank line, then a footer of column-formula
 * and definition text. Collecting rows strictly before the first blank line
 * after the header is what keeps that footer text out of the data — it is
 * not itself tab-separated into the same shape and would otherwise look like
 * a malformed row rather than a row to skip.
 *
 * Table 1 also carries real aggregate rows IN the data block (not just in the
 * footer) — "All Countries", "Grand Total", "Total Europe"/"Total Asia"/etc.,
 * "Memo: Euro Area", and eighteen "Of Which: ..." institutional-sector
 * breakouts. These are legitimate rows with real history, not noise, so a
 * caller who names one by label gets it — they are only EXCLUDED from the
 * default by-country ranking, via TABLE1_AGGREGATE_LABELS /
 * TABLE1_AGGREGATE_PREFIXES below, both read straight off the file's own
 * label set (verified against a live fetch, not guessed).
 */


const UA = 'pipeworx-mcp/1.0 (bruce@mojibake.ai)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Treasury TIC');
}

const TABLE1_URL = 'https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table1.txt';
const MFH_URL = 'https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt';

const PUBLISHER = 'U.S. Department of the Treasury';
const DATASET_1 = 'Treasury International Capital (TIC) System, Table 1: U.S. Long-Term Securities Held by Foreign Residents';
const DATASET_MFH = 'Treasury International Capital (TIC) System, Major Foreign Holders of Treasury Securities table';

// ── Table 1 parsing ─────────────────────────────────────────────────────

interface Table1Row {
  country: string;
  country_code: string;
  month: string; // YYYY-MM
  total_holdings_usd_mil: number | null;
  total_net_purchases_usd_mil: number | null;
  total_valuation_change_usd_mil: number | null;
  treasury_holdings_usd_mil: number | null;
  treasury_net_purchases_usd_mil: number | null;
  treasury_valuation_change_usd_mil: number | null;
  agency_bond_holdings_usd_mil: number | null;
  agency_bond_net_purchases_usd_mil: number | null;
  agency_bond_valuation_change_usd_mil: number | null;
  corp_bond_holdings_usd_mil: number | null;
  corp_bond_net_purchases_usd_mil: number | null;
  corp_bond_valuation_change_usd_mil: number | null;
  equity_holdings_usd_mil: number | null;
  equity_net_purchases_usd_mil: number | null;
  equity_valuation_change_usd_mil: number | null;
}

// Real labels, read off a live fetch of the file (2026-10-17) — not guessed.
// Country rows never start with these; aggregate/grouping rows always do.
const TABLE1_AGGREGATE_EXACT = new Set(['All Countries', 'Grand Total', 'International']);
const TABLE1_AGGREGATE_PREFIXES = ['Of Which:', 'Total ', 'Memo:'];

function isTable1Aggregate(label: string): boolean {
  if (TABLE1_AGGREGATE_EXACT.has(label)) return true;
  return TABLE1_AGGREGATE_PREFIXES.some((p) => label.startsWith(p));
}

function numOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === '' || t.toLowerCase() === 'n.a.' || t.toLowerCase() === 'n/a') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Collect lines after the machine-readable header until the first blank line. */
function dataBlockAfterHeader(lines: string[], headerPredicate: (cols: string[]) => boolean): string[][] {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (headerPredicate(cols)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) throw new Error('Treasury TIC upstream file layout changed — expected header row not found');
  const out: string[][] = [];
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\t+$/, '').trim();
    if (trimmed === '') break;
    out.push(lines[i].replace(/\t+$/, '').split('\t'));
  }
  return out;
}

function parseTable1(text: string): Table1Row[] {
  const lines = text.split(/\r?\n/);
  const rows = dataBlockAfterHeader(
    lines,
    (cols) => cols[0] === 'country' && cols[1] === 'country_code' && cols[2] === 'date',
  );
  const out: Table1Row[] = [];
  for (const c of rows) {
    if (c.length < 18 || !/^\d{4}-\d{2}$/.test(c[2])) continue;
    out.push({
      country: c[0],
      country_code: c[1],
      month: c[2],
      total_holdings_usd_mil: numOrNull(c[3]),
      total_net_purchases_usd_mil: numOrNull(c[4]),
      total_valuation_change_usd_mil: numOrNull(c[5]),
      treasury_holdings_usd_mil: numOrNull(c[6]),
      treasury_net_purchases_usd_mil: numOrNull(c[7]),
      treasury_valuation_change_usd_mil: numOrNull(c[8]),
      agency_bond_holdings_usd_mil: numOrNull(c[9]),
      agency_bond_net_purchases_usd_mil: numOrNull(c[10]),
      agency_bond_valuation_change_usd_mil: numOrNull(c[11]),
      corp_bond_holdings_usd_mil: numOrNull(c[12]),
      corp_bond_net_purchases_usd_mil: numOrNull(c[13]),
      corp_bond_valuation_change_usd_mil: numOrNull(c[14]),
      equity_holdings_usd_mil: numOrNull(c[15]),
      equity_net_purchases_usd_mil: numOrNull(c[16]),
      equity_valuation_change_usd_mil: numOrNull(c[17]),
    });
  }
  return out;
}

// ── Major Foreign Holders table parsing (wide: one row per label, columns = months) ──

interface MfhTable {
  months: string[]; // newest first, as published
  rows: { label: string; values: Record<string, number | null> }[];
}

const MFH_AGGREGATE_LABELS = new Set([
  'All Other',
  'Grand Total',
  'Of Which: Foreign Official',
  'Of Which: Foreign Official Treasury Bills',
  'Of Which: Foreign Official T-Bonds & Notes',
]);

function parseMfh(text: string): MfhTable {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\t+$/, '').split('\t')[0] === 'Country') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('Treasury TIC upstream Major Foreign Holders file layout changed — header row not found');
  const headerCols = lines[headerIdx].replace(/\t+$/, '').split('\t');
  const months = headerCols.slice(1).filter((m) => /^\d{4}-\d{2}$/.test(m));
  const rows: MfhTable['rows'] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\t+$/, '').trim();
    if (trimmed === '') break;
    const cols = lines[i].replace(/\t+$/, '').split('\t');
    const label = cols[0];
    if (!label) continue;
    const values: Record<string, number | null> = {};
    months.forEach((m, idx) => {
      values[m] = numOrNull(cols[idx + 1]);
    });
    rows.push({ label, values });
  }
  return { months, rows };
}

// ── Country name matching ──────────────────────────────────────────────

const COUNTRY_ALIASES: Record<string, string> = {
  china: 'China, Mainland',
  prc: 'China, Mainland',
  "people's republic of china": 'China, Mainland',
  'south korea': 'Korea, South',
  korea: 'Korea, South',
  uk: 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  uae: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
};

function normalizeLabel(s: string): string {
  return s.toLowerCase().trim().replace(/[.,]/g, '');
}

/** Case/punctuation-insensitive match with a small alias table, against the DISTINCT labels seen. */
function matchLabel(requested: string, labels: string[]): { match: string | null; suggestions: string[] } {
  const norm = normalizeLabel(requested);
  const aliased = COUNTRY_ALIASES[norm];
  if (aliased && labels.includes(aliased)) return { match: aliased, suggestions: [] };
  const exact = labels.find((l) => normalizeLabel(l) === norm);
  if (exact) return { match: exact, suggestions: [] };
  // Loose: label contains the request or vice versa (handles "Korea" -> "Korea, South").
  const loose = labels.filter((l) => normalizeLabel(l).includes(norm) || norm.includes(normalizeLabel(l)));
  if (loose.length === 1) return { match: loose[0], suggestions: [] };
  return { match: null, suggestions: loose.length ? loose : labels.slice(0, 8) };
}

// ── Tools ───────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'tic_foreign_holdings',
    description:
      `Foreign holdings of U.S. long-term securities by country and month, from ${PUBLISHER}'s ${DATASET_1}. Covers Treasury securities, agency bonds, corporate bonds and corporate equity, each with holdings, net U.S. purchases/sales and a valuation-change breakdown. Pass "country" for one country's recent history (e.g. "Japan", "China"); omit it for a ranking of the largest foreign holders of U.S. securities in a given month (default: most recently published). Monthly cadence, published with roughly a 6-week lag. Answers "how much does Japan hold in US securities", "who are the biggest foreign holders of US stocks and bonds", "has China been buying or selling US Treasuries".`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: {
          type: 'string',
          description: 'Country name, e.g. "Japan", "China", "United Kingdom". Omit for a cross-country ranking.',
        },
        month: {
          type: 'string',
          description: 'YYYY-MM. Omit for the most recently published month.',
        },
        limit: {
          type: 'number',
          description: 'Ranking mode: how many countries to return (1-50, default 20). Country mode: how many recent months of history (1-60, default 12).',
        },
      },
    },
  },
  {
    name: 'tic_major_treasury_holders',
    description:
      `The "Major Foreign Holders of Treasury Securities" ranking from ${PUBLISHER}'s ${DATASET_MFH} — the figure financial press cites as "<country> holds $X of US Treasuries." Covers the ~20 largest individual foreign holders plus an "All Other" bucket, the grand total, and the foreign-official-sector split (central banks/governments vs. private holders), in USD billions. Pass "country" for one country's recent months; omit it for the full ranking in a given month (default: most recently published). Only the largest ~20 holders are broken out individually — a smaller holder is not in this table even though it may appear in tic_foreign_holdings. Answers "how much Treasury debt does China hold", "who are the top foreign holders of US government debt".`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: {
          type: 'string',
          description: 'One of the ~20 individually-broken-out countries, e.g. "Japan", "China". Omit for the full ranking.',
        },
        month: {
          type: 'string',
          description: 'YYYY-MM. Omit for the most recently published month.',
        },
        limit: {
          type: 'number',
          description: 'Ranking mode: how many countries to return (1-25, default 21, i.e. all of them). Country mode: how many recent months of history (1-13, default 13, the full window the table publishes).',
        },
      },
    },
  },
];

function monthsDesc(all: string[]): string[] {
  return Array.from(new Set(all)).sort((a, b) => b.localeCompare(a));
}

async function ticForeignHoldings(args: Record<string, unknown>): Promise<unknown> {
  const res = await pwFetch(TABLE1_URL);
  if (!res.ok) throw new Error(`Treasury TIC Table 1 upstream returned ${res.status}`);
  const rows = parseTable1(await res.text());
  if (!rows.length) throw new Error('Treasury TIC Table 1 upstream returned no parseable rows');

  const availableMonths = monthsDesc(rows.map((r) => r.month));
  const requestedMonth = typeof args.month === 'string' && args.month.trim() ? args.month.trim() : null;
  const month = requestedMonth && availableMonths.includes(requestedMonth) ? requestedMonth : availableMonths[0];

  const countryArg = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : null;

  if (requestedMonth && !availableMonths.includes(requestedMonth)) {
    return {
      found: false,
      requested_month: requestedMonth,
      hint: `No Treasury TIC Table 1 data published for ${requestedMonth}. Most recent available month is ${availableMonths[0]}; oldest available is ${availableMonths[availableMonths.length - 1]}.`,
      available_months_sample: availableMonths.slice(0, 6),
      source: `${PUBLISHER}, ${DATASET_1}`,
    };
  }

  if (countryArg) {
    const allLabels = Array.from(new Set(rows.map((r) => r.country)));
    const { match, suggestions } = matchLabel(countryArg, allLabels);
    if (!match) {
      return {
        found: false,
        requested_country: countryArg,
        hint: `No country or grouping in Treasury TIC Table 1 matches "${countryArg}".`,
        suggestions,
        source: `${PUBLISHER}, ${DATASET_1}`,
      };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 60);
    const history = rows
      .filter((r) => r.country === match)
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, limit);
    return {
      found: true,
      country: match,
      unit: 'USD millions',
      data_as_of: history[0]?.month ?? null,
      latest: history[0] ?? null,
      history,
      source: `${PUBLISHER}, ${DATASET_1}`,
    };
  }

  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  const worldTotal = rows.find((r) => r.country === 'All Countries' && r.month === month) ?? null;
  const ranked = rows
    .filter((r) => r.month === month && !isTable1Aggregate(r.country))
    .sort((a, b) => (b.total_holdings_usd_mil ?? -Infinity) - (a.total_holdings_usd_mil ?? -Infinity))
    .slice(0, limit);
  return {
    found: true,
    month,
    data_as_of: month,
    unit: 'USD millions',
    world_total: worldTotal,
    count: ranked.length,
    rank: ranked,
    source: `${PUBLISHER}, ${DATASET_1}`,
  };
}

async function ticMajorTreasuryHolders(args: Record<string, unknown>): Promise<unknown> {
  const res = await pwFetch(MFH_URL);
  if (!res.ok) throw new Error(`Treasury TIC Major Foreign Holders upstream returned ${res.status}`);
  const table = parseMfh(await res.text());
  if (!table.months.length || !table.rows.length) {
    throw new Error('Treasury TIC Major Foreign Holders upstream returned no parseable rows');
  }

  const availableMonths = table.months; // already newest-first as published
  const requestedMonth = typeof args.month === 'string' && args.month.trim() ? args.month.trim() : null;
  const month = requestedMonth && availableMonths.includes(requestedMonth) ? requestedMonth : availableMonths[0];

  const countryArg = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : null;

  if (requestedMonth && !availableMonths.includes(requestedMonth)) {
    return {
      found: false,
      requested_month: requestedMonth,
      hint: `No Treasury TIC Major Foreign Holders data published for ${requestedMonth}. Available months: ${availableMonths.join(', ')}.`,
      available_months: availableMonths,
      source: `${PUBLISHER}, ${DATASET_MFH}`,
    };
  }

  if (countryArg) {
    const allLabels = table.rows.map((r) => r.label);
    const { match, suggestions } = matchLabel(countryArg, allLabels.filter((l) => !MFH_AGGREGATE_LABELS.has(l)));
    const fallback = match ?? (allLabels.includes(countryArg) ? countryArg : null);
    if (!fallback) {
      return {
        found: false,
        requested_country: countryArg,
        hint: `"${countryArg}" is not individually broken out in the Major Foreign Holders table (only the largest ~20 holders are). Try tic_foreign_holdings for broader by-country coverage, or pick one of the countries this table names.`,
        suggestions,
        individually_named_countries: allLabels.filter((l) => !MFH_AGGREGATE_LABELS.has(l)),
        source: `${PUBLISHER}, ${DATASET_MFH}`,
      };
    }
    const row = table.rows.find((r) => r.label === fallback)!;
    const limit = Math.min(Math.max(Number(args.limit) || availableMonths.length, 1), availableMonths.length);
    const history = availableMonths.slice(0, limit).map((m) => ({ month: m, holdings_usd_bil: row.values[m] ?? null }));
    return {
      found: true,
      country: fallback,
      unit: 'USD billions',
      data_as_of: history[0]?.month ?? null,
      latest: history[0] ?? null,
      history,
      source: `${PUBLISHER}, ${DATASET_MFH}`,
    };
  }

  const limit = Math.min(Math.max(Number(args.limit) || 21, 1), 25);
  const byLabel = new Map(table.rows.map((r) => [r.label, r.values[month] ?? null]));
  const rank = table.rows
    .filter((r) => !MFH_AGGREGATE_LABELS.has(r.label))
    .map((r) => ({ country: r.label, holdings_usd_bil: r.values[month] ?? null }))
    .sort((a, b) => (b.holdings_usd_bil ?? -Infinity) - (a.holdings_usd_bil ?? -Infinity))
    .slice(0, limit);
  return {
    found: true,
    month,
    data_as_of: month,
    unit: 'USD billions',
    aggregates: {
      grand_total_usd_bil: byLabel.get('Grand Total') ?? null,
      all_other_usd_bil: byLabel.get('All Other') ?? null,
      foreign_official_total_usd_bil: byLabel.get('Of Which: Foreign Official') ?? null,
      foreign_official_bills_usd_bil: byLabel.get('Of Which: Foreign Official Treasury Bills') ?? null,
      foreign_official_bonds_notes_usd_bil: byLabel.get('Of Which: Foreign Official T-Bonds & Notes') ?? null,
    },
    count: rank.length,
    rank,
    source: `${PUBLISHER}, ${DATASET_MFH}`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'tic_foreign_holdings':
      return ticForeignHoldings(args);
    case 'tic_major_treasury_holders':
      return ticMajorTreasuryHolders(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

// Exported for unit tests only — not part of the MCP tool surface.
export const __testing = {
  parseTable1,
  parseMfh,
  matchLabel,
  isTable1Aggregate,
  numOrNull,
};
