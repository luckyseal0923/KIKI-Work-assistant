// Call sites supply only fixed event names and explicitly selected metadata.
// Never pass request objects, errors, SQL parameters, or environment values.
export function log(event, metadata = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...metadata })}\n`);
}
