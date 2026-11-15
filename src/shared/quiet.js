/**
 * node:sqlite is stable enough for this local index but still emits an
 * ExperimentalWarning on Node 24.  Suppress only that warning so CLI JSON
 * output stays clean; all other warnings pass through.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const text =
    typeof warning === "string" ? warning : warning?.message || String(warning);
  if (/SQLite is an experimental feature/i.test(text)) return;
  return originalEmitWarning(warning, ...args);
};
