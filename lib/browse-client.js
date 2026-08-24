const { CompositeDisposable, Emitter, Task } = require("lumine");

const BROWSE_WATCHDOG_MS = 15_000;
const QUERY_TIMEOUT_MS = 30_000;

class BrowseClient {
  constructor(filePath) {
    this.filePath = filePath;
    this.epoch = 0;
    this.revision = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.emitter = new Emitter();
    this.destroyed = false;
    this.startBrowseTask();
  }

  startBrowseTask() {
    if (this.destroyed) return;
    this.stopBrowseTask();
    this.epoch += 1;
    const task = new Task(require.resolve("./sqlite/browse-task"));
    this.task = task;
    this.taskSubscriptions = new CompositeDisposable(
      task.on("sqlite-view:reply", (reply) => this.handleReply(reply)),
      task.on("task:error", (message) => this.handleTaskFailure(new Error(message))),
      task.on("task:cancelled", () => this.handleTaskFailure(codeError("CANCELLED"))),
    );
    task.start({ path: this.filePath, epoch: this.epoch, revision: this.revision }, (result) => {
      if (!this.destroyed && result?.error) {
        this.handleTaskFailure(toError(result.error));
      }
    });
  }

  request(op, payload = {}) {
    if (this.destroyed) return Promise.reject(codeError("DESTROYED"));
    return new Promise((resolve, reject) => {
      this.queue.push({ op, payload, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.destroyed || this.active || !this.queue.length) return;
    if (!this.task) this.startBrowseTask();
    const next = this.queue.shift();
    const request = {
      v: 1,
      epoch: this.epoch,
      id: this.nextId++,
      revision: this.revision,
      op: next.op,
      payload: next.payload,
    };
    this.active = request.id;
    this.pending.set(request.id, next);
    this.watchdog = setTimeout(() => {
      const pending = this.pending.get(request.id);
      if (!pending) return;
      this.pending.delete(request.id);
      this.active = null;
      pending.reject(codeError("TIMEOUT", "SQLite browse request timed out."));
      this.restart();
    }, BROWSE_WATCHDOG_MS);
    try {
      this.task.send({ event: "sqlite-view:request", args: [request] });
    } catch (error) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
      this.pending.delete(request.id);
      this.active = null;
      next.reject(error);
      this.restart();
    }
  }

  handleReply(reply) {
    if (!reply || reply.epoch !== this.epoch) return;
    if (reply.event === "database-changed") {
      this.revision = Math.max(this.revision + 1, reply.revision || reply.result?.revision || 0);
      this.rejectPending(codeError("STALE_REVISION"));
      this.emitter.emit("did-change-database", reply.result || reply);
      return;
    }
    if (reply.event === "database-error") {
      this.emitter.emit("did-fail", toError(reply.error));
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending || reply.id !== this.active) return;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    this.pending.delete(reply.id);
    this.active = null;
    if (Number.isInteger(reply.revision)) this.revision = reply.revision;
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(toError(reply.error));
    this.pump();
  }

  handleTaskFailure(error) {
    if (this.destroyed) return;
    this.rejectPending(error);
    this.emitter.emit("did-fail", error);
  }

  rejectPending(error, pump = true) {
    clearTimeout(this.watchdog);
    this.watchdog = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.active = null;
    if (pump) this.pump();
  }

  restart(filePath = this.filePath) {
    this.filePath = filePath;
    this.stopBrowseTask();
    this.rejectPending(codeError("RESTARTED"), false);
    this.startBrowseTask();
    this.pump();
  }

  runQuery(sql, onEvent) {
    this.cancelQuery();
    const task = new Task(require.resolve("./sqlite/query-task"));
    this.queryTask = task;
    let sawError = false;
    const timeout = setTimeout(() => {
      if (this.queryTask !== task) return;
      subscriptions.dispose();
      if (this.querySubscriptions === subscriptions) this.querySubscriptions = null;
      task.cancel();
      this.queryTask = null;
      onEvent?.({ type: "error", error: { code: "TIMEOUT", message: "Query timed out." } });
    }, QUERY_TIMEOUT_MS);
    const subscriptions = new CompositeDisposable(
      task.on("sqlite-view:query-event", (event) => {
        if (event?.type === "error") sawError = true;
        onEvent?.(event);
      }),
      task.on("task:cancelled", () =>
        onEvent?.({ type: "error", error: { code: "CANCELLED", message: "Query cancelled." } }),
      ),
    );
    this.querySubscriptions = subscriptions;
    task.start({ path: this.filePath, sql, revision: this.revision }, (summary) => {
      clearTimeout(timeout);
      subscriptions.dispose();
      if (this.querySubscriptions === subscriptions) this.querySubscriptions = null;
      task.terminate();
      if (this.queryTask === task) this.queryTask = null;
      if (summary?.error && !sawError) {
        onEvent?.({ type: "error", error: summary.error });
      }
    });
    return task;
  }

  runCount(payload) {
    this.cancelCount();
    return new Promise((resolve, reject) => {
      const task = new Task(require.resolve("./sqlite/count-task"));
      this.countTask = task;
      this.countReject = reject;
      const timeout = setTimeout(() => {
        if (this.countTask !== task) return;
        task.cancel();
        this.countTask = null;
        this.countReject = null;
        this.countTimeout = null;
        reject(codeError("TIMEOUT", "Count timed out."));
      }, QUERY_TIMEOUT_MS);
      this.countTimeout = timeout;
      task.start({ path: this.filePath, revision: this.revision, request: payload }, (reply) => {
        clearTimeout(timeout);
        task.terminate();
        if (this.countTask === task) this.countTask = null;
        this.countReject = null;
        this.countTimeout = null;
        if (reply?.ok) resolve(reply.result);
        else reject(toError(reply?.error));
      });
    });
  }

  cancelQuery() {
    const task = this.queryTask;
    this.queryTask = null;
    this.querySubscriptions?.dispose();
    this.querySubscriptions = null;
    return task?.cancel() || false;
  }

  cancelCount() {
    const task = this.countTask;
    this.countTask = null;
    clearTimeout(this.countTimeout);
    this.countTimeout = null;
    const reject = this.countReject;
    this.countReject = null;
    const cancelled = task?.cancel() || false;
    if (cancelled) reject?.(codeError("CANCELLED", "Count cancelled."));
    return cancelled;
  }

  onDidChangeDatabase(callback) {
    return this.emitter.on("did-change-database", callback);
  }

  onDidFail(callback) {
    return this.emitter.on("did-fail", callback);
  }

  stopBrowseTask() {
    clearTimeout(this.watchdog);
    this.watchdog = null;
    this.taskSubscriptions?.dispose();
    this.taskSubscriptions = null;
    this.task?.terminate();
    this.task = null;
  }

  suspend() {
    this.rejectPending(codeError("SUSPENDED"), false);
    this.stopBrowseTask();
  }

  resume() {
    if (!this.task && !this.destroyed) {
      this.startBrowseTask();
      return true;
    }
    return false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelQuery();
    this.cancelCount();
    this.stopBrowseTask();
    this.rejectPending(codeError("DESTROYED"));
    this.queue.splice(0).forEach(({ reject }) => reject(codeError("DESTROYED")));
    this.emitter.dispose();
  }
}

function codeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toError(dto = {}) {
  const error = codeError(dto.code || "SQLITE_ERROR", dto.message || "SQLite request failed.");
  error.sqliteCode = dto.sqliteCode;
  error.sqliteName = dto.sqliteName;
  return error;
}

module.exports = { BrowseClient, BROWSE_WATCHDOG_MS, QUERY_TIMEOUT_MS, codeError };
