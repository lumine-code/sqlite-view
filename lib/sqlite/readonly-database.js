"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, constants } = require("node:sqlite");
const { BUSY_TIMEOUT_MS, MAX_QUERY_VALUE_BYTES, MAX_SQL_BYTES } = require("./constants");
const { fail } = require("./errors");

const COMMON_ACTIONS = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_RECURSIVE,
  constants.SQLITE_FUNCTION,
]);

const INTERNAL_PRAGMAS = new Set([
  "application_id",
  "data_version",
  "encoding",
  "foreign_key_list",
  "index_list",
  "index_xinfo",
  "schema_version",
  "table_list",
  "table_xinfo",
  "trusted_schema",
  "user_version",
]);

const DENIED_FUNCTIONS = new Set(["edit", "load_extension", "readfile", "writefile"]);

function statPart(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeMs: Math.trunc(stat.mtimeMs),
      birthtimeMs: Math.trunc(stat.birthtimeMs),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function diskFingerprint(filePath) {
  return {
    main: statPart(filePath),
    wal: statPart(`${filePath}-wal`),
    shm: statPart(`${filePath}-shm`),
  };
}

function validateDatabaseFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("FILE_NOT_FOUND", `Database does not exist: ${filePath}`);
    throw error;
  }
  if (!stat.isFile()) fail("NOT_A_FILE", `Database path is not a file: ${filePath}`);
  if (stat.size === 0) return;
  if (stat.size < 16) fail("NOT_SQLITE", "File is too short to be a SQLite database.");

  const handle = fs.openSync(filePath, "r");
  try {
    const header = Buffer.allocUnsafe(16);
    fs.readSync(handle, header, 0, header.length, 0);
    if (!header.equals(Buffer.from("SQLite format 3\0", "binary"))) {
      fail("NOT_SQLITE", "File does not have a SQLite 3 header.");
    }
  } finally {
    fs.closeSync(handle);
  }
}

class ReadonlyDatabase {
  constructor(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath === "") {
      fail("INVALID_PATH", "A database file path is required.");
    }
    this.path = path.resolve(filePath);
    validateDatabaseFile(this.path);
    this.mode = "deny";
    this.db = new DatabaseSync(this.path, {
      readOnly: true,
      defensive: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: false,
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: true,
      returnArrays: true,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
    });
    this.db.exec("PRAGMA query_only = ON");
    this.db.exec("PRAGMA trusted_schema = OFF");
    this.db.limits.sqlLength = MAX_SQL_BYTES;
    if (options.queryLimits) this.applyQueryLimits();
    this.db.setAuthorizer((...args) => this.authorize(...args));
    this.initialFingerprint = this.fingerprint();
  }

  applyQueryLimits() {
    this.db.limits.length = MAX_QUERY_VALUE_BYTES;
    this.db.limits.column = 512;
    this.db.limits.exprDepth = 200;
    this.db.limits.compoundSelect = 50;
    this.db.limits.vdbeOp = 5_000_000;
    this.db.limits.functionArg = 100;
    this.db.limits.attach = 0;
    this.db.limits.likePatternLength = 10_000;
    this.db.limits.variableNumber = 999;
    this.db.limits.triggerDepth = 0;
  }

  authorize(action, arg1, arg2, dbName) {
    if (COMMON_ACTIONS.has(action)) {
      if (action === constants.SQLITE_FUNCTION && DENIED_FUNCTIONS.has(arg2?.toLowerCase())) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    }
    if (action === constants.SQLITE_READ) {
      // SQLite reports a null database name for count(*) because no concrete
      // column is read. The connection has no writable temp schema and ATTACH
      // is denied, so this special case is still confined to the main file.
      return dbName === "main" || dbName == null ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    if (
      this.mode === "internal" &&
      action === constants.SQLITE_PRAGMA &&
      INTERNAL_PRAGMAS.has(arg1?.toLowerCase())
    ) {
      return constants.SQLITE_OK;
    }
    return constants.SQLITE_DENY;
  }

  withMode(mode, callback) {
    const previous = this.mode;
    this.mode = mode;
    try {
      return callback(this.db);
    } finally {
      this.mode = previous;
    }
  }

  internal(callback) {
    return this.withMode("internal", callback);
  }

  user(callback) {
    return this.withMode("user", callback);
  }

  pragmaValue(name) {
    if (!INTERNAL_PRAGMAS.has(name)) fail("INVALID_PRAGMA", `Unsupported internal PRAGMA ${name}.`);
    return this.internal((db) => db.prepare(`PRAGMA ${name}`).get()?.[0]);
  }

  dataVersion() {
    return String(this.pragmaValue("data_version"));
  }

  schemaVersion() {
    return String(this.pragmaValue("schema_version"));
  }

  fingerprint() {
    return diskFingerprint(this.path);
  }

  close() {
    if (this.db?.isOpen) this.db.close();
  }
}

module.exports = {
  INTERNAL_PRAGMAS,
  ReadonlyDatabase,
  diskFingerprint,
  validateDatabaseFile,
};
