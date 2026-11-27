# Span

A planner on a zoomable timeline (hours to years), for a long trip or a weekend: items nest inside items, either/or groups hold options, and costs add up as you go. Runs as a single Cloudflare Worker: static UI from `public/`, a JSON API in `src/worker.ts`, plans stored in D1 and pictures in R2.

UI mockups live in [`docs/mockups.html`](docs/mockups.html) (open it locally in a browser). The main view is **Lanes** (sketch 16: rounded bubbles on a day grid, built for a plan that hasn't decided where to go next). The other views read the same plan: **Calendar**, **Map**, **Cards** and **Story**, plus **Zoom**, the original zoom timeline with the "Compare plans" chart as its cost panel.

## Using it

- **Views:** pick one under the summary (it's remembered). **Lanes** shows one row per item. A closed row shows what's inside as a chain of bubbles; an either/or group shows its pick as a stacked "deck"; a *fork* (a group whose options are whole trips, like "Thailand or Taiwan") shows one chain per trip with each trip's plan total. Open a row with its arrow or a bubble; tap an option's number to make it the pick. The buttons at the top are the trips you're choosing between, with the plan total for each. **Calendar** puts the picked trip on month grids; **Map** draws it between known cities (stays named after a city, like "Hoi An homestay", or flights with airport codes), with the other trips dashed and a day slider; **Cards** is a phone-first stack with rivals one tap away; **Story** tells it as chapters with boarding-pass stubs.
- **+ Sample** adds a plan that hasn't decided between Thailand and Taiwan after Saigon, each with flights in, room options and a flight home.
- **Items** hold items: a country holds rooms, a Saturday holds lunch and a gig. Each is measured in nights, days or hours, starts on a date, when its parent starts (plus some days), or right after another item. Leave the length empty to stretch it over what's inside. A *fixed window* (visa, lease) never moves.
- **Either/or groups** hold options; only the top-ranked one counts. Drag an option up or down (long-press first on a phone) or use its Rank buttons. Outside groups, rank is just lane order.
- **Committed or optional:** only committed items count toward totals, unless **Count optional** is on.
- **Costs:** each item has cost lines that are fixed, per night/day/hour, or a fare by date on a shared route. Tick "each person" to multiply by the plan's **People**.
- **Warnings:** inside an item, nights nothing covers are marked red and nights booked twice amber.
- **Open what's inside:** on desktop, the chevron expands in place (about three levels on screen); on a phone, it drills in, with a breadcrumb back.
- **Links and pictures:** paste a Booking, Agoda or Airbnb (or any) link onto an item and it shows as a site chip that opens in a new tab. Paste, drop or choose a picture; it's shrunk in the browser (1200 px WebP plus a thumbnail) and kept in R2.
- **Deciding how long to stay:** the first adjustable item with something after it is the one you're deciding on. Drag the end of its bar, use the slider, or tap a day in the fare strip. The compare panel shows each option's total and a chart by departure day.
- Plans save automatically to D1. Round-1 plans upgrade in the browser when opened (no migration). The first visit creates a sample plan (90-day Vietnam visa from Oct 20 2026, rooms in Vietnam, Bangkok/Taipei options, made-up prices).

## Layout

| Path | What |
| --- | --- |
| `wrangler.jsonc` | Worker config: assets (SPA fallback), custom domain, D1 binding `DB`, R2 binding `IMAGES` (bucket `span-images`) |
| `src/worker.ts` | API under `/api/*`; everything else is served from `public/` |
| `migrations/` | D1 schema (`0001_plans.sql`: one JSON document per plan) |
| `public/` | Static UI: `index.html`, `styles.css`, and plain ES modules in `app/` (no build step) |
| `public/app/model.js` | Plan document (v2) and v1 upgrade, layout of nested and chained items, counting, cost math, coverage, sample plan (pure, unit-tested) |
| `public/app/trip.js` | Forks, totals as if an option were picked, price ranges, where you sleep, flights, and the still-deciding sample (pure, unit-tested) |
| `public/app/places.js` | Built-in city table, place names for items, the trip as stops (pure, unit-tested) |
| `public/app/lanes.js` | Lanes view (main); `calendar.js`, `routemap.js`, `cards.js`, `story.js` the other views; `timeline.js` + `compare.js` the Zoom view; styles for the new views in `public/views.css` |
| `public/app/images.js` | Resizes pictures in the browser before upload |
| `test/` | `node --test` unit tests for the model, trips and places |
| `docs/mockups.html` | The UI directions (mockups) |

## API

| Route | Does |
| --- | --- |
| `GET /api/health` | `{ ok, db, time }` |
| `GET /api/plans` | List plans (id, name, updated_at), newest first |
| `POST /api/plans` | Create from `{ name, body? }`; `body` is any JSON object (512 KB max) |
| `GET /api/plans/:id` | One plan with its body |
| `PUT /api/plans/:id` | Update `name` and/or `body` |
| `DELETE /api/plans/:id` | Delete, along with the plan's pictures |
| `POST /api/images` | Store a picture: multipart `full` (≤1.5 MB) and `thumb` (≤200 KB), WebP, JPEG or PNG only; returns `{ id }` |
| `GET /api/images/:id[/thumb]` | The picture or its thumbnail |
| `DELETE /api/images/:id` | Delete a picture |

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
5. Create the picture bucket: `npx wrangler r2 bucket create span-images`
6. Deploy: `npm run deploy` (applies pending D1 migrations, then deploys the Worker).

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

