# Privie's Campus Bites

A campus restaurant ordering and operations MVP using React, Express, Socket.IO, and PostgreSQL (Neon) or local SQLite. The customer website and staff dashboard share data through the API and update order/reservation changes in real time.

## Run locally

1. Install Node.js 22.5 or newer.
2. In this folder, run `npm install` once.
3. Copy `.env.example` to `.env`, then set a long random `JWT_SECRET` and a private `ADMIN_PASSWORD`.
4. Run `npm run dev` (builds the React frontend and starts the API/web server).
5. Open `http://localhost:3001`.

The project already has a local `.env` for this computer. Initial manager sign-in:\r\n\r\n- Use the local demo credentials provided with this LAN-ready package.\r\n
Change the password in `.env` before sharing or deploying the project. The first admin is created from those settings when the database is first seeded. When `DATABASE_URL` is set, data is stored in PostgreSQL and the schema/seed data are created automatically at startup. When it is empty, SQLite data lives in `data/restaurant.sqlite`. Keep the Neon connection string in the ignored local `.env` file; never commit it or paste it into chat.

## Implemented

- Customer registration and login with bcrypt password hashing, signed 12-hour JWTs, role checks, and customer order/reservation history
- Menu categories, availability, manager create/edit/remove controls, CSV import/export, and filtering/search
- Cart, server-side pricing and tax calculation, pay-at-pickup orders, order invoice pages printable to PDF
- Table requests with 30-minute slots, capacity checks, status management, and duplicate-capacity prevention
- Kitchen, floor, and manager screens with Socket.IO order and reservation updates
- Persistent in-app notifications for orders, reservation status, contact messages, payment confirmation, and low stock
- Ingredient stock, reorder levels, suppliers, purchase orders with received-stock updates, stock adjustment history, menu recipes, and stock reduction when an order is served
- Daily sales and reservation totals, popular dish counts, staff account management, and customer feedback
- Responsive design and a dark mode toggle

## Payment setup

Online card checkout is implemented through Stripe Checkout, but is hidden until valid Stripe keys are placed in `.env`. Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and set `PUBLIC_URL` to your site origin. Configure a Stripe webhook for `/api/payments/webhook` and the `checkout.session.completed` event. Until then, customers can place pay-at-pickup orders. Never commit real payment keys. Checkout and invoices use the server-calculated rates in `TAX_RATE`, `SERVICE_RATE`, and `DISCOUNT_RATE`; rates are decimals from `0` to `1` (for example, `0.05` is 5%).

For a school presentation, the local `.env` enables `DEMO_PAYMENTS=true`. The cart then shows a clearly labeled simulated payment choice. It marks the order paid for demonstrating the workflow, but it does not collect card details, contact a provider, or move money. Keep this disabled for any public/live deployment.

## Data and deployment

The app supports Neon PostgreSQL through `DATABASE_URL` and automatically creates the tables and demo seed data on first startup. If no URL is configured, it uses Node's built-in SQLite store for local development. For a public class-demo deployment, use the Render Blueprint in `render.yaml` and follow `DEPLOYMENT.md`; hosted deployments must configure Neon because local SQLite files are not persistent on Render Free.

Run `npm run build` to create `dist/`, then `npm start` to serve the built site and API. A production deployment also needs a persistent database volume or hosted database, HTTPS, a production JWT secret, Stripe keys/webhook, and an allowed origin. The earlier Netlify deployment has not been updated; this full-stack app needs a Node-capable host for the API and persistent database.

### Container deployment preparation

`Dockerfile` and `compose.yaml` are included for a single-instance container deployment with a persistent SQLite volume. Create a private `.env` from `.env.example`, set a strong `JWT_SECRET` and `ADMIN_PASSWORD`, then run `docker compose up --build`. The app will be available on port 3001. This does not publish the app to a public hosting account. Set `DATABASE_URL` in `.env` to use Neon PostgreSQL.

## Notes

- Tax defaults to 5% via `TAX_RATE` in `.env`; check the applicable business tax settings before real sales.
- Orders calculate prices on the server, and stock is deducted transactionally only when an order reaches `Served`.
- The seeded supplier and inventory quantities are sample data. Replace them with the restaurant's real stock, supplier, and recipe figures.
- `work/legacy-static-site.html` and `work/legacy-static-site.js` preserve the first browser-only prototype.
