export function handleHealth(req, res, sendJSON) {
  sendJSON(res, 200, {
    status: 'ok',
    service: 'youeye-connector-runtime',
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}
