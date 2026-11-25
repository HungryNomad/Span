/**
 * Span Worker: JSON API under `/api/*`. Everything else is served from
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

/**
 * Builds a JSON response.
 *
 * @param data - Value to serialise.
 * @param status - HTTP status, 200 by default.
 * @returns A `Response` with a JSON content type.
 */
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

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
 * @returns The normalised fields, or a 400 `Response` if the payload is invalid.
 */
async function readPlan(
  req: Request,
  partial: boolean,
): Promise<{ name?: string; body?: string } | Response> {
  const input = await req.json<PlanInput>().catch(() => null);
  if (!input || typeof input !== "object") return error(400, "expected a JSON object");

  const { name, body } = input;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return error(400, "name must be a non-empty string");
  }
  if (!partial && name === undefined) return error(400, "name is required");
  if (body !== undefined && (body === null || typeof body !== "object")) {
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

/** `DELETE /api/plans/:id`: removes a plan. */
const deletePlan: Handler = async (_req, env, [id]) => {
  const { meta } = await env.DB.prepare("DELETE FROM plans WHERE id = ?").bind(id).run();
  return meta.changes ? new Response(null, { status: 204 }) : error(404, "plan not found");
};

/** Route table: method, path pattern (capture groups become params), handler. */
const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/health$/, health],
  ["GET", /^\/api\/plans$/, listPlans],
  ["POST", /^\/api\/plans$/, createPlan],
  ["GET", /^\/api\/plans\/([\w-]+)$/, getPlan],
  ["PUT", /^\/api\/plans\/([\w-]+)$/, updatePlan],
  ["DELETE", /^\/api\/plans\/([\w-]+)$/, deletePlan],
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
