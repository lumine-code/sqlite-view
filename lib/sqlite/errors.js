"use strict";

class SqliteViewError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "SqliteViewError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SqliteViewError(code, message, details);
}

function errorDto(error) {
  if (error instanceof SqliteViewError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details == null ? {} : { details: error.details }),
    };
  }

  const message = error?.message || String(error);
  const sqliteCode = Number.isInteger(error?.errcode) ? error.errcode : undefined;
  const sqliteName = typeof error?.errstr === "string" ? error.errstr : undefined;
  let code =
    typeof error?.code === "string" && !error.code.startsWith("ERR_SQLITE")
      ? error.code
      : "SQLITE_ERROR";
  if (/locked|busy/i.test(message)) code = "BUSY";
  if (/not a database|malformed|corrupt/i.test(message)) code = "CORRUPT_DATABASE";
  if (/string or blob too big/i.test(message)) code = "RESULT_VALUE_TOO_LARGE";
  if (/not authorized|readonly/i.test(message)) code = "QUERY_NOT_READ_ONLY";

  return {
    code,
    message,
    ...(sqliteCode == null ? {} : { sqliteCode }),
    ...(sqliteName == null ? {} : { sqliteName }),
  };
}

module.exports = { SqliteViewError, errorDto, fail };
