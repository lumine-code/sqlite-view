"use strict";

function emitTaskEvent(event, payload) {
  if (typeof global.emit === "function") {
    global.emit(event, payload);
  } else if (process.connected) {
    process.send({ event, args: [payload] });
  }
}

function runStandalone(handler) {
  if (require.main !== module.parent) return;
  let started = false;
  process.on("message", (message = {}) => {
    if (started || message.event !== "start") return;
    started = true;
    const context = {
      async() {
        return (result) => {
          emitTaskEvent("task:completed", result);
          setImmediate(() => process.disconnect?.());
        };
      },
    };
    const result = handler.call(context, ...(message.args || []));
    if (result !== undefined) {
      emitTaskEvent("task:completed", result);
      setImmediate(() => process.disconnect?.());
    }
  });
}

module.exports = { emitTaskEvent, runStandalone };
