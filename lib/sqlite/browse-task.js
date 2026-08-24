"use strict";

const { PROTOCOL_VERSION } = require("./constants");
const { BrowseEngine } = require("./browse-engine");
const { errorDto } = require("./errors");
const { emitTaskEvent, runStandalone } = require("./task-runtime");

function browseTask(options) {
  const done = this.async();
  const epoch = Number.isInteger(options?.epoch) ? options.epoch : 1;
  let engine;
  let active = true;
  let timer = null;

  const emitReply = (reply) => emitTaskEvent("sqlite-view:reply", reply);
  const finish = (result) => {
    done(result);
    setImmediate(() => process.disconnect?.());
  };
  const baseReply = (id) => ({
    v: PROTOCOL_VERSION,
    epoch,
    id,
    revision: engine?.revision ?? options?.revision ?? 1,
  });

  const emitExternalError = (error) => {
    emitReply({
      ...baseReply(null),
      ok: false,
      event: "database-error",
      error: errorDto(error),
    });
  };

  try {
    engine = new BrowseEngine(options);
    emitReply({
      ...baseReply(0),
      ok: true,
      event: "ready",
      result: engine.catalog(options.catalogOptions),
    });
  } catch (error) {
    emitExternalError(error);
    finish({ ok: false, error: errorDto(error) });
    return;
  }

  const checkVersion = () => {
    try {
      const result = engine.checkExternal();
      if (result.changed) {
        emitReply({
          ...baseReply(null),
          ok: true,
          event: "database-changed",
          result,
        });
      }
      return result;
    } catch (error) {
      emitExternalError(error);
      return null;
    }
  };

  timer = setInterval(() => {
    if (active) checkVersion();
  }, 1000);
  timer.unref?.();

  const onMessage = (message = {}) => {
    if (message.event !== "sqlite-view:request") return;
    const [request = {}] = message.args || [];
    if (request.epoch != null && request.epoch !== epoch) return;
    const reply = baseReply(request.id ?? null);
    try {
      if (request.v !== PROTOCOL_VERSION) {
        throw Object.assign(new Error(`Unsupported SQLite protocol version ${request.v}.`), {
          code: "UNSUPPORTED_PROTOCOL",
        });
      }
      let result;
      switch (request.op) {
        case "catalog":
          engine.assertRevision(request.revision);
          result = engine.catalog(request.payload);
          break;
        case "describe":
          engine.assertRevision(request.revision);
          result = engine.describe(request.payload?.name);
          break;
        case "page":
          result = engine.page({ ...request.payload, revision: request.revision });
          break;
        case "cell":
          result = engine.cell({ ...request.payload, revision: request.revision });
          break;
        case "check-version":
          result = checkVersion();
          break;
        case "set-active":
          active = Boolean(request.payload?.active);
          result = { active };
          break;
        case "close":
          result = { closed: true };
          emitReply({ ...reply, revision: engine.revision, ok: true, result });
          clearInterval(timer);
          process.off("message", onMessage);
          engine.close();
          finish({ ok: true, result });
          return;
        default:
          throw Object.assign(new Error(`Unknown browse operation ${request.op}.`), {
            code: "UNKNOWN_OPERATION",
          });
      }
      emitReply({ ...reply, revision: engine.revision, ok: true, result });
    } catch (error) {
      emitReply({ ...reply, revision: engine.revision, ok: false, error: errorDto(error) });
    }
  };

  process.on("message", onMessage);
}

module.exports = browseTask;
runStandalone(browseTask);
