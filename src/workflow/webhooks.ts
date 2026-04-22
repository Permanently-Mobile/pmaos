import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { Hono } from 'hono';
import pino from 'pino';

import {
  createWebhook,
  deleteWebhook,
  getAllWebhooks,
  getWebhook,
} from './db.js';
import { emitEvent } from './triggers.js';

const logger = pino({ name: 'workflow-webhooks' });

/**
 * Create Hono sub-app for inbound webhook receiver.
 *
 * POST /receive/:id -- external webhook receiver (no dashboard auth, uses per-webhook secret)
 * GET / -- list webhooks (inherits dashboard auth from parent mount)
 * POST / -- create webhook (inherits dashboard auth from parent mount)
 * DELETE /:id -- delete webhook (inherits dashboard auth from parent mount)
 */
export function createWebhookApp(): Hono {
  const app = new Hono();

  // ── Inbound webhook receiver (per-webhook secret auth) ────────────

  app.post('/receive/:id', async (c) => {
    const id = c.req.param('id');
    const webhook = getWebhook(id);

    if (!webhook || !webhook.active) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Always validate webhook secret -- secrets are required on all webhooks
    if (!webhook.secret) {
      logger.error({ webhookId: id }, 'Webhook missing secret (corrupted record)');
      return c.json({ error: 'Webhook misconfigured' }, 500);
    }

    const authHeader = c.req.header('Authorization');
    const sigHeader = c.req.header('X-Webhook-Signature');
    const fireflySignature = c.req.header('Signature');

    if (sigHeader) {
      // HMAC-SHA256 signature validation (standard format)
      const body = await c.req.text();
      const expected = createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
      const sigBuf = Buffer.from(sigHeader, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (
        sigBuf.length !== expectedBuf.length ||
        !timingSafeEqual(sigBuf, expectedBuf)
      ) {
        logger.warn({ webhookId: id }, 'Webhook signature mismatch');
        return c.json({ error: 'Invalid signature' }, 401);
      }
    } else if (fireflySignature) {
      // Firefly III format: Signature: t=<timestamp>,v1=<hmac_hex>
      const body = await c.req.text();
      const parts = Object.fromEntries(
        fireflySignature.split(',').map((p) => {
          const [k, ...v] = p.split('=');
          return [k.trim(), v.join('=')];
        }),
      );
      if (!parts.t || !parts.v1) {
        logger.warn({ webhookId: id }, 'Malformed Firefly signature');
        return c.json({ error: 'Invalid signature format' }, 401);
      }
      const expected = createHmac('sha256', webhook.secret)
        .update(`${parts.t}.${body}`)
        .digest('hex');
      const sigBuf = Buffer.from(parts.v1, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (
        sigBuf.length !== expectedBuf.length ||
        !timingSafeEqual(sigBuf, expectedBuf)
      ) {
        logger.warn({ webhookId: id }, 'Firefly webhook signature mismatch');
        return c.json({ error: 'Invalid signature' }, 401);
      }
    } else if (authHeader) {
      // Bearer token validation
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (token !== webhook.secret) {
        logger.warn({ webhookId: id }, 'Webhook bearer token mismatch');
        return c.json({ error: 'Invalid token' }, 401);
      }
    } else {
      return c.json({ error: 'Missing authentication' }, 401);
    }

    // Parse body
    let payload: unknown;
    try {
      const contentType = c.req.header('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        payload = await c.req.json();
      } else {
        payload = await c.req.text();
      }
    } catch {
      payload = null;
    }

    logger.info(
      { webhookId: id, name: webhook.name, event: webhook.event_name },
      'Webhook received',
    );

    // Emit event to trigger workflows
    emitEvent(webhook.event_name, {
      webhookId: id,
      webhookName: webhook.name,
      workflowId: webhook.workflow_id,
      payload,
    });

    return c.json({ ok: true });
  });

  // ── Management routes (auth inherited from dashboard middleware) ───

  // List all webhooks
  app.get('/', async (c) => {
    const webhooks = getAllWebhooks();
    return c.json(webhooks);
  });

  // Create a webhook -- secret is always required (auto-generated if not provided)
  app.post('/', async (c) => {
    const body = (await c.req.json()) as {
      name?: string;
      secret?: string;
      workflow_id?: string;
      event_name?: string;
    };
    if (!body.name || !body.workflow_id) {
      return c.json({ error: 'Missing name or workflow_id' }, 400);
    }
    // Generate a random secret if none provided
    const secret = body.secret || randomBytes(32).toString('hex');
    const id = createWebhook({
      name: body.name,
      secret,
      workflowId: body.workflow_id,
      eventName: body.event_name,
    });
    return c.json({ id, secret, url: `/api/webhooks/receive/${id}` }, 201);
  });

  // Delete a webhook
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = deleteWebhook(id);
    if (!deleted) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
