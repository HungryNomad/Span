# Span

A travel planner on a zoomable timeline (hours to years): visa windows, stays and trip options as bars, with stay and travel costs. Runs as a single Cloudflare Worker: static UI from `public/`, a JSON API in `src/worker.ts`, and plans stored in D1.

UI mockups live in [`docs/mockups.html`](docs/mockups.html) (open it locally in a browser). The app is the "Zoom timeline" direction with the "Compare plans" chart as its cost panel.

## Using it

- **Bars:** a *fixed window* (visa, lease) never moves. A *stay* starts on a date, or right after another bar ("Starts after"), optionally arriving by a flight. Give a stay fewest/most nights to make it adjustable.
- **Deciding how long to stay:** the first adjustable stay with options after it is the one you're deciding on. Drag the end of its bar, use the slider, or tap a day in the fare strip under the timeline.
- **Fares:** tap a flight or a fare cell to enter the fare for that day; days without one use the route's usual fare. Routes are shared by every stay that uses them.
- **Cost panel:** every way to continue after that stay, its total (stays + travel, or one of them), the cheapest day to leave, and a chart of totals by departure day.
- Plans save automatically to D1. The first visit creates a sample plan (90-day Vietnam visa from Oct 20 2026, Bangkok/Taipei options, made-up prices).

## Layout

| Path | What |
| --- | --- |
| `wrangler.jsonc` | Worker config: assets (SPA fallback), custom domain, D1 binding `DB` |
| `src/worker.ts` | API under `/api/*`; everything else is served from `public/` |
| `migrations/` | D1 schema (`0001_plans.sql`: one JSON document per plan) |
| `public/` | Static UI: `index.html`, `styles.css`, and plain ES modules in `app/` (no build step) |
| `public/app/model.js` | Plan document shape, layout of chained bars, cost math, sample plan (pure, unit-tested) |
| `test/` | `node --test` unit tests for the model |
| `docs/mockups.html` | The UI directions (mockups) |

## API

| Route | Does |
| --- | --- |
| `GET /api/health` | `{ ok, db, time }` |
| `GET /api/plans` | List plans (id, name, updated_at), newest first |
| `POST /api/plans` | Create from `{ name, body? }`; `body` is any JSON object (512 KB max) |
| `GET /api/plans/:id` | One plan with its body |
| `PUT /api/plans/:id` | Update `name` and/or `body` |
| `DELETE /api/plans/:id` | Delete |

## Local development

```sh
npm install
npm run db:migrate:local   # creates the local D1 database under .wrangler/
npm run dev                # http://localhost:8787
npm run typecheck          # generates worker-configuration.d.ts, then tsc (Worker + JSDoc-checked UI)
npm test                   # model unit tests
```

With Deno 2 instead of npm (it runs the same `package.json` scripts):

```sh
deno install
deno task db:migrate:local
deno task dev
```

## First deploy

1. Log in: `npx wrangler login`
2. Create the database: `npx wrangler d1 create span`
3. Paste the printed `database_id` into `wrangler.jsonc` (replacing the zeros).
4. Set your subdomain: change `plan.example.com` in `wrangler.jsonc` to the real one. The domain's zone must be on the same Cloudflare account; Wrangler creates the DNS record and certificate.
5. Deploy: `npm run deploy` (applies pending D1 migrations, then deploys the Worker).

## Auto-deploy with Workers Builds

Cloudflare dashboard → Workers & Pages → `span` → Settings → Builds → Connect, then pick `HungryNomad/Span`, branch `main`.

- Build command: `npm ci`
- Deploy command: `npm run deploy`

Every push to `main` then migrates D1 and deploys. If the migration step fails with a permission error, give the build's API token D1 edit access.

## Keep it private with Cloudflare Access

Zero Trust → Access → Applications → Add → Self-hosted:

- Application domain: your subdomain (the one in `wrangler.jsonc`)
- Policy: Allow, include your email (and anyone you plan with)

`workers_dev` and `preview_urls` are off in `wrangler.jsonc`, so the custom domain is the only way in.

