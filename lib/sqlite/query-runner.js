"use strict";

const {
  MAX_QUERY_BYTES,
  MAX_QUERY_ROWS,
  QUERY_CHUNK_BYTES,
  QUERY_CHUNK_ROWS,
} = require("./constants");
const { ReadonlyDatabase } = require("./readonly-database");
const { assertSingleStatement, assertSqlText } = require("./sql");
const { fail } = require("./errors");
const { gridCell, jsonBytes } = require("./values");

function columnDto(column) {
  return {
    name: column.name,
    column: column.column,
    table: column.table,
    database: column.database,
    declaredType: column.type,
  };
}

function runQuery(options, onEvent = () => {}) {
  const database = new ReadonlyDatabase(options.path, { queryLimits: true });
  const id = options.id ?? 0;
  const startTime = Date.now();
  const beforeVersion = database.dataVersion();
  let iterator = null;
  try {
    assertSqlText(options.sql);
    const summary = database.user((db) => {
      const statement = db.prepare(options.sql);
      assertSingleStatement(options.sql, statement.sourceSQL);
      const columns = statement.columns().map(columnDto);
      if (columns.length === 0) {
        fail("QUERY_NOT_READ_ONLY", "The statement does not return a result set.");
      }
      onEvent({ type: "start", id, columns });
      iterator = statement.iterate();
      let rows = 0;
      let bytes = 0;
      let sequence = 0;
      let chunk = [];
      let chunkBytes = 0;
      let truncated = null;

      const flush = () => {
        if (chunk.length === 0) return;
        onEvent({ type: "chunk", id, seq: sequence++, rows: chunk });
        chunk = [];
        chunkBytes = 0;
      };

      for (const rawRow of iterator) {
        if (rows >= MAX_QUERY_ROWS) {
          truncated = "rows";
          break;
        }
        const row = rawRow.map(gridCell);
        const rowBytes = jsonBytes(row);
        if (bytes + rowBytes > MAX_QUERY_BYTES) {
          truncated = "bytes";
          break;
        }
        chunk.push(row);
        rows++;
        bytes += rowBytes;
        chunkBytes += rowBytes;
        if (chunk.length >= QUERY_CHUNK_ROWS || chunkBytes >= QUERY_CHUNK_BYTES) flush();
      }
      flush();
      return { columns, rows, bytes, truncated };
    });
    const changed = database.dataVersion() !== beforeVersion;
    const done = {
      type: "done",
      id,
      rows: summary.rows,
      bytes: summary.bytes,
      truncated: summary.truncated,
      elapsedMs: Date.now() - startTime,
      databaseChangedDuringRun: changed,
    };
    onEvent(done);
    return done;
  } finally {
    iterator?.return?.();
    database.close();
  }
}

module.exports = { runQuery };
