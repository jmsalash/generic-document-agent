// Starts the assistant, unless one is already running on this computer (for example its Docker container).
// In that case it does not start a second copy: it stays attached and reports whether the running one is healthy,
// without stopping or changing it.
const PORT = Number(process.env.PORT || 8792);
const health = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return null; }
};

const running = await health();
if (!running) {
  await import('../relay/server.js');
} else {
  console.log(`The assistant is already running on port ${PORT} (probably its Docker container), so no second copy is started.`);
  console.log(`Setup page: http://localhost:${PORT}/setup`);
  let last = '';
  const report = async () => {
    const h = await health();
    const now = !h ? 'not answering' : h.ok ? `ready (${h.sessions}/${h.maxSessions} conversations)` : 'running, but the key or document is missing';
    if (now !== last) { console.log(`Assistant: ${now}`); last = now; }
  };
  await report();
  setInterval(report, 30000);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { console.log('detached (the running assistant keeps running)'); process.exit(0); });
}
