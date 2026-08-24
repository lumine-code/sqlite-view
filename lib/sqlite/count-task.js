"use strict";

const { BrowseEngine } = require("./browse-engine");
const { errorDto } = require("./errors");
const { emitTaskEvent, runStandalone } = require("./task-runtime");

function countTask(options) {
  const id = options?.id ?? 0;
  const startTime = Date.now();
  emitTaskEvent("sqlite-view:query-event", { type: "start", id, operation: "count" });
  let engine = null;
  try {
    engine = new BrowseEngine(options);
    const result = engine.count({ ...options.request, revision: engine.revision });
    const event = {
      type: "done",
      id,
      operation: "count",
      count: result.count,
      elapsedMs: Date.now() - startTime,
      revision: result.revision,
    };
    emitTaskEvent("sqlite-view:query-event", event);
    return { ok: true, result: event };
  } catch (error) {
    const event = { type: "error", id, operation: "count", error: errorDto(error) };
    emitTaskEvent("sqlite-view:query-event", event);
    return { ok: false, error: event.error };
  } finally {
    engine?.close();
  }
}

module.exports = countTask;
runStandalone(countTask);
