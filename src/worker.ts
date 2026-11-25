/**
 * Span Worker: JSON API under `/api/*`, plus item pictures in R2. Everything else is served from
 * `public/` by the assets binding (see `wrangler.jsonc`), so this code only
 * runs for API requests.
 *
 * @module
 */

/** Summary row returned by `GET /api/plans`. */
interface PlanSummary {
  id: string;
  name: string;
  updated_at: number;
}

/** Full plan row; `body` is the plan document as stored JSON text. */
interface PlanRow extends PlanSummary {
  body: string;
  created_at: number;
}

/** Request body accepted by `POST` and `PUT /api/plans`. */
interface PlanInput {
  name?: unknown;
  body?: unknown;
}

/** A route handler: receives the request, bindings and path parameters. */
type Handler = (req: Request, env: Env, params: string[]) => Promise<Response>;

/** Largest plan payload accepted, in bytes (D1 rows cap out around 2 MB). */
const MAX_BODY = 512 * 1024;

/** Largest stored picture and thumbnail, in bytes (the browser resizes first). */
const MAX_FULL = 1.5 * 1024 * 1024, MAX_THUMB = 200 * 1024;

/** Image ids are UUIDs; anything else is rejected before touching R2. */
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Builds a JSON response. API data is per-user and changes often, so it is
 * never cached.
 *
 * @param data - Value to serialise.
 * @param status - HTTP status, 200 by default.
 * @returns A `Response` with a JSON content type.
 */
const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

/**
 * Builds a JSON error response of the form `{ error }`.
 *
 * @param status - HTTP status code.
 * @param message - Human-readable reason.
 * @returns A `Response` carrying the error.
 */
const error = (status: number, message: string): Response => json({ error: message }, status);

/**
 * Parses and validates a plan payload.
 *
 * @param req - Incoming request with a JSON body.
 * @param partial - When true (updates), `name` may be omitted.
 * @returns The normalised fields, or a 400/413 `Response` if the payload is invalid.
 */
async function readPlan(
  req: Request,
  partial: boolean,
): Promise<{ name?: string; body?: string } | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "plan too large");
  let input: PlanInput | null = null;
  try {
    input = JSON.parse(text);
  } catch { /* falls through to the 400 below */ }
  if (!input || typeof input !== "object" || Array.isArray(input)) return error(400, "expected a JSON object");

  const { name, body } = input;
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    return error(400, "name must be a string of 1-200 characters");
  }
  if (!partial && name === undefined) return error(400, "name is required");
  if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
    return error(400, "body must be a JSON object");
  }

  return {
    name: typeof name === "string" ? name.trim() : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/**
 * Converts a stored row into its API shape, parsing `body` back into JSON.
 *
 * @param row - Row as read from D1.
 * @returns The plan with `body` as an object.
 */
const toPlan = ({ body, ...rest }: PlanRow) => ({ ...rest, body: JSON.parse(body) });

/** `GET /api/health`: liveness plus a trivial D1 round trip. */
const health: Handler = async (_req, env) => {
  const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>().catch(() => null);
  return json({ ok: true, db: db?.ok === 1, time: new Date().toISOString() });
};

/** `GET /api/plans`: lists plans, most recently updated first. */
const listPlans: Handler = async (_req, env) => {
  const { results } = await env.DB
    .prepare("SELECT id, name, updated_at FROM plans ORDER BY updated_at DESC")
    .all<PlanSummary>();
  return json(results);
};

/** `POST /api/plans`: creates a plan from `{ name, body? }`. */
const createPlan: Handler = async (req, env) => {
  const input = await readPlan(req, false);
  if (input instanceof Response) return input;

  const row = await env.DB
    .prepare("INSERT INTO plans (id, name, body) VALUES (?, ?, ?) RETURNING *")
    .bind(crypto.randomUUID(), input.name, input.body ?? "{}")
    .first<PlanRow>();
  return json(toPlan(row!), 201);
};

/** `GET /api/plans/:id`: returns one plan with its full body. */
const getPlan: Handler = async (_req, env, [id]) => {
  const row = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first<PlanRow>();
  return row ? json(toPlan(row)) : error(404, "plan not found");
};

/** `PUT /api/plans/:id`: updates `name` and/or `body`. */
const updatePlan: Handler = async (req, env, [id]) => {
  const input = await readPlan(req, true);
  if (input instanceof Response) return input;

  const row = await env.DB
    .prepare(
      `UPDATE plans
          SET name = coalesce(?, name), body = coalesce(?, body), updated_at = unixepoch()
        WHERE id = ? RETURNING *`,
    )
    .bind(input.name ?? null, input.body ?? null, id)
    .first<PlanRow>();
  return row ? json(toPlan(row)) : error(404, "plan not found");
};

/** `DELETE /api/plans/:id`: removes a plan and, best effort, its pictures. */
const deletePlan: Handler = async (_req, env, [id]) => {
  const row = await env.DB.prepare("DELETE FROM plans WHERE id = ? RETURNING body").bind(id).first<{ body: string }>();
  if (!row) return error(404, "plan not found");
  const ids = imagesIn(row.body);
  if (env.IMAGES && ids.length) await env.IMAGES.delete(ids.flatMap(keys)).catch((err) => console.error(err));
  return new Response(null, { status: 204 });
};

/**
 * Image ids referenced by a stored plan body (`items[].images`).
 *
 * @param body - Plan document as JSON text.
 * @returns Valid image ids, deduplicated.
 */
function imagesIn(body: string): string[] {
  try {
    const items: unknown = JSON.parse(body)?.items;
    if (!Array.isArray(items)) return [];
    const ids = items.flatMap((it) => (Array.isArray(it?.images) ? it.images : []));
    return [...new Set(ids.filter((x): x is string => typeof x === "string" && IMAGE_ID.test(x)))];
  } catch {
    return [];
  }
}

/**
 * R2 keys for an image: the full picture and its thumbnail.
 *
 * @param id - Image id.
 * @returns `[full, thumb]` keys.
 */
const keys = (id: string): [string, string] => [`img/${id}`, `img/${id}/t`];

/**
 * Sniffs a picture's type from its first bytes, so only real images are
 * stored and served (never HTML or SVG under an image URL).
 *
 * @param bytes - File contents.
 * @returns The MIME type, or null if it isn't WebP, JPEG or PNG.
 */
function imageType(bytes: Uint8Array): string | null {
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  return null;
}

/**
 * Fails fast when the R2 binding isn't configured.
 *
 * @param env - Worker bindings.
 * @returns The bucket, or a 503 `Response`.
 */
const bucket = (env: Env): R2Bucket | Response =>
  env.IMAGES ?? error(503, "picture storage is not set up (R2 binding IMAGES)");

/**
 * Reads one uploaded file part and checks its size and type.
 *
 * @param form - Parsed multipart body.
 * @param name - Field name.
 * @param max - Size cap in bytes.
 * @returns The bytes and sniffed type, or a 400/413 `Response`.
 */
async function readPart(form: FormData, name: string, max: number): Promise<{ bytes: Uint8Array; type: string } | Response> {
  const file = form.get(name);
  if (!(file instanceof File)) return error(400, `missing ${name} picture`);
  if (file.size > max) return error(413, `${name} picture too large`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = imageType(bytes);
  return type ? { bytes, type } : error(400, `${name} is not a WebP, JPEG or PNG picture`);
}

/** `POST /api/images`: stores a resized picture and its thumbnail (multipart `full`, `thumb`). */
const uploadImage: Handler = async (req, env) => {
  const r2 = bucket(env);
  if (r2 instanceof Response) return r2;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_FULL + MAX_THUMB + 64 * 1024) return error(413, "upload too large");
  const form = await req.formData().catch(() => null);
  if (!form) return error(400, "expected multipart form data");
  const full = await readPart(form, "full", MAX_FULL);
  if (full instanceof Response) return full;
  const thumb = await readPart(form, "thumb", MAX_THUMB);
  if (thumb instanceof Response) return thumb;

  const id = crypto.randomUUID(), [fk, tk] = keys(id);
  await Promise.all([
    r2.put(fk, full.bytes, { httpMetadata: { contentType: full.type } }),
    r2.put(tk, thumb.bytes, { httpMetadata: { contentType: thumb.type } }),
  ]);
  return json({ id }, 201);
};

/** `GET /api/images/:id` and `/api/images/:id/thumb`: serves a stored picture. */
const getImage: Handler = async (_req, env, [id, thumb]) => {
  const r2 = bucket(env);
  if (r2 instanceof Response) return r2;
  const obj = await r2.get(keys(id)[thumb ? 1 : 0]);
  if (!obj) return error(404, "picture not found");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: obj.httpEtag,
    },
  });
};

/** `DELETE /api/images/:id`: removes a picture and its thumbnail. */
const deleteImage: Handler = async (_req, env, [id]) => {
  const r2 = bucket(env);
  if (r2 instanceof Response) return r2;
  await r2.delete(keys(id));
  return new Response(null, { status: 204 });
};

/** Route table: method, path pattern (capture groups become params), handler. */
const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/health$/, health],
  ["GET", /^\/api\/plans$/, listPlans],
  ["POST", /^\/api\/plans$/, createPlan],
  ["GET", /^\/api\/plans\/([\w-]+)$/, getPlan],
  ["PUT", /^\/api\/plans\/([\w-]+)$/, updatePlan],
  ["DELETE", /^\/api\/plans\/([\w-]+)$/, deletePlan],
  ["POST", /^\/api\/images$/, uploadImage],
  ["GET", /^\/api\/images\/([0-9a-f-]{36})(\/thumb)?$/, getImage],
  ["DELETE", /^\/api\/images\/([0-9a-f-]{36})$/, deleteImage],
];

export default {
  /**
   * Dispatches API requests to the matching route; anything else is handed
   * back to the static assets.
   *
   * @param req - Incoming request.
   * @param env - Bindings declared in `wrangler.jsonc`.
   * @returns The route's response, 404/405 for unknown API paths, or an asset.
   */
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // Worker Previews run without production bindings (see `previews` in wrangler.jsonc).
    if (!env.DB && pathname.startsWith("/api/plans")) return error(503, "plan storage is not set up (D1 binding DB)");

    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (method === req.method) {
        try {
          return await handler(req, env, match.slice(1));
        } catch (err) {
          console.error(err);
          return error(500, "internal error");
        }
      }
    }
    return pathMatched ? error(405, "method not allowed") : error(404, "not found");
  },
} satisfies ExportedHandler<Env>;
