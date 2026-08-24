"use strict";

const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { MAX_SQL_BYTES } = require("./constants");
const { fail } = require("./errors");

function quoteIdentifier(identifier) {
  if (typeof identifier !== "string") fail("INVALID_IDENTIFIER", "Identifier must be text.");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertSqlText(sql) {
  if (typeof sql !== "string" || sql.trim() === "") fail("EMPTY_QUERY", "Enter a SQL query.");
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    fail("QUERY_TOO_LARGE", `SQL is limited to ${MAX_SQL_BYTES} UTF-8 bytes.`);
  }
}

function assertSingleStatement(sql, sourceSql) {
  assertSqlText(sql);
  let index = sourceSql.length;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    fail("MULTIPLE_STATEMENTS", "Only one SQL statement can be executed at a time.");
  }
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

module.exports = { assertSingleStatement, assertSqlText, quoteIdentifier, stableHash };
