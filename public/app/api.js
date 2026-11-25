// @ts-check
/**
 * Thin client for the Worker's `/api/plans` endpoints.
 *
 * @module
 */

/**
 * A stored plan as the API returns it.
 * @typedef {{id: string, name: string, updated_at: number, created_at?: number, body?: unknown}} PlanRecord
 */

/**
 * Calls the API and decodes JSON.
 * @param {string} method HTTP method.
 * @param {string} path Path under `/api`, e.g. `/plans`.
 * @param {unknown} [body] JSON body.
 * @param {RequestInit} [init] Extra fetch options (e.g. `keepalive`).
 * @returns {Promise<any>} Parsed JSON, or null for 204.
 * @throws {Error} With the server's message when the response isn't OK.
 */
async function call(method, path, body, init = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Lists plans, newest first.
 * @returns {Promise<PlanRecord[]>}
 */
export const listPlans = () => call('GET', '/plans');

/**
 * Loads one plan with its body.
 * @param {string} id
 * @returns {Promise<PlanRecord>}
 */
export const getPlan = (id) => call('GET', `/plans/${encodeURIComponent(id)}`);

/**
 * Creates a plan.
 * @param {string} name
 * @param {object} body Plan document.
 * @returns {Promise<PlanRecord>}
 */
export const createPlan = (name, body) => call('POST', '/plans', { name, body });

/**
 * Updates a plan's name and/or body.
 * @param {string} id
 * @param {{name?: string, body?: object}} patch
 * @param {boolean} [keepalive] Let the request outlive the page (for saves on close).
 * @returns {Promise<PlanRecord>}
 */
export const updatePlan = (id, patch, keepalive = false) =>
  call('PUT', `/plans/${encodeURIComponent(id)}`, patch, { keepalive });

/**
 * Deletes a plan.
 * @param {string} id
 * @returns {Promise<null>}
 */
export const deletePlan = (id) => call('DELETE', `/plans/${encodeURIComponent(id)}`);
