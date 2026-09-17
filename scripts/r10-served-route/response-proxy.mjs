import { createServer, request } from 'node:http';
import { appendFileSync } from 'node:fs';

export async function startResponseProxy({ upstream, port, controlPort, logPath }) {
  const destination = new URL(upstream);
  if (!['127.0.0.1', 'localhost'].includes(destination.hostname)) throw new Error('Response proxy upstream must be local.');
  let armed;
  const events = [];
  const proxy = createServer((incoming, outgoing) => {
    const path = new URL(incoming.url, 'http://local').pathname;
    const drop = armed?.method === incoming.method && armed.path === path;
    if (drop) armed = undefined;
    const forwarded = request(new URL(incoming.url, destination), { method: incoming.method, headers: { ...incoming.headers, host: destination.host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const event = { method: incoming.method, path, status: response.statusCode, dropped: drop, completedAt: new Date().toISOString() };
        events.push(event);
        if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
        if (drop) outgoing.destroy();
        else { outgoing.writeHead(response.statusCode ?? 502, response.headers); outgoing.end(Buffer.concat(chunks)); }
      });
    });
    forwarded.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(forwarded);
  });
  const control = createServer(async (incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/status') {
      outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify({ armed, dropped: events.filter(event => event.dropped).length })); return;
    }
    if (incoming.method !== 'POST' || incoming.url !== '/drop-next') { outgoing.writeHead(404); outgoing.end(); return; }
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const next = JSON.parse(Buffer.concat(chunks).toString());
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(next.method) || typeof next.path !== 'string' || !next.path.startsWith('/')) throw new Error('Invalid drop selector');
      if (armed) { outgoing.writeHead(409); outgoing.end('A drop is already armed.'); return; }
      armed = { method: next.method, path: next.path };
      outgoing.writeHead(204); outgoing.end();
    } catch { outgoing.writeHead(400); outgoing.end('Expected a method and exact path.'); }
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, '127.0.0.1', resolve); });
  try { await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', resolve); }); }
  catch (error) { proxy.close(); throw error; }
  return { port: proxy.address().port, controlPort: control.address().port, events,
    close: () => Promise.all([proxy, control].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))),
  };
}
