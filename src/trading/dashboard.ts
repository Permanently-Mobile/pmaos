/**
 * Trading Dashboard -- Trading Data Visualization Routes
 *
 * This is a stub module included as an extension point. The full module
 * provides Hono routes for charting OHLCV data, indicator overlays,
 * position tracking, and watchlist management.
 *
 * Implement to add a trading dashboard panel to the main dashboard.
 */

import { Hono } from 'hono';

/**
 * Create trading dashboard routes as a Hono sub-app.
 * Mounts under /trading on the main dashboard.
 *
 * Stub: returns an empty Hono app. Implement to enable trading dashboard.
 */
export function createTradingRoutes(_token: string): Hono {
  const app = new Hono();

  app.get('/', (c) => c.text('Trading dashboard not installed. Add the trading module to enable.'));

  return app;
}
