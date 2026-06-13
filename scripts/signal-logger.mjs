const levels = ['debug', 'info', 'warn', 'error'];
const secretPattern = /(token|secret|password|authorization|cookie|credential)/i;

function levelValue(level) {
  const index = levels.indexOf(level);
  return index >= 0 ? index : levels.indexOf('info');
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    secretPattern.test(key) ? '[redacted]' : redact(child),
  ]));
}

export function createLogger({ env = process.env, service, sink = console.log } = {}) {
  const minLevel = String(env.SIGNAL_LOG_LEVEL ?? 'info').toLowerCase();
  const minValue = levelValue(minLevel);
  function emit(level, event, fields = {}) {
    if (levelValue(level) < minValue) {
      return;
    }
    sink(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...redact(fields),
    }));
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    error: (event, fields) => emit('error', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
  };
}
