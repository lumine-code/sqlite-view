"use strict";

const { errorDto } = require("./errors");
const { runQuery } = require("./query-runner");
const { emitTaskEvent, runStandalone } = require("./task-runtime");

function queryTask(options) {
  try {
    const result = runQuery(options, (event) => emitTaskEvent("sqlite-view:query-event", event));
    return { ok: true, result };
  } catch (error) {
    const event = { type: "error", id: options?.id ?? 0, error: errorDto(error) };
    emitTaskEvent("sqlite-view:query-event", event);
    return { ok: false, error: event.error };
  }
}

module.exports = queryTask;
runStandalone(queryTask);
