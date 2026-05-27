import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { api } from './routes/api.js';
import { forms } from './routes/forms.js';
import { menu } from './routes/menu.js';
import { triggers } from './routes/triggers.js';

const app = new Hono();

app.onError((err, c) => {
  console.error('[hono] unhandled error:', err);
  return c.json({ err: String(err) }, 500);
});

const internal = new Hono();

internal.route('/menu', menu);
internal.route('/form', forms);
internal.route('/triggers', triggers);

app.route('/api', api);
app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
