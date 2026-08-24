"use strict";

const {
  CELL_BLOB_LIMIT,
  CELL_TEXT_LIMIT,
  CURSOR_VALUE_LIMIT,
  DEFAULT_PAGE_ROWS,
  GRID_BLOB_PREVIEW_BYTES,
  GRID_TEXT_LIMIT,
  MAX_CURSOR_BYTES,
  MAX_FILTERS,
  MAX_FILTER_VALUE_BYTES,
  MAX_PAGE_BYTES,
  MAX_PAGE_COLUMNS,
  MAX_PAGE_ROWS,
  PROTOCOL_VERSION,
} = require("./constants");
const { databaseInfo, describeObject, listObjects } = require("./catalog");
const { ReadonlyDatabase } = require("./readonly-database");
const { fail } = require("./errors");
const { quoteIdentifier, stableHash } = require("./sql");
const { decodeScalar, encodeScalar, gridCellFromProjection, jsonBytes } = require("./values");

const FILTER_OPERATORS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "is-null",
  "not-null",
  "contains",
  "starts-with",
]);

function qualifiedColumn(column) {
  return `data.${quoteIdentifier(column.name)}`;
}

function identityExpressions(description) {
  if (description.identity.mode === "rowid") {
    return [`data.${quoteIdentifier(description.identity.alias)}`];
  }
  if (description.identity.mode === "primary-key") {
    const byId = new Map(description.columns.map((column) => [column.id, column]));
    return description.identity.columnIds.map((id) => qualifiedColumn(byId.get(id)));
  }
  return [];
}

function columnMap(description) {
  return new Map(description.columns.map((column) => [column.id, column]));
}

function validateFilters(description, filters = []) {
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    fail("INVALID_FILTERS", `At most ${MAX_FILTERS} filters are supported.`);
  }
  const columns = columnMap(description);
  return filters.map((filter) => {
    if (!filter || !columns.has(filter.columnId) || !FILTER_OPERATORS.has(filter.op)) {
      fail("INVALID_FILTER", "Filter refers to an unknown column or operator.");
    }
    const needsValue = filter.op !== "is-null" && filter.op !== "not-null";
    if (needsValue && !Object.hasOwn(filter, "value")) {
      fail("INVALID_FILTER", `Filter ${filter.op} requires a value.`);
    }
    if (needsValue && jsonBytes(filter.value) > MAX_FILTER_VALUE_BYTES) {
      fail("INVALID_FILTER", `Filter values are limited to ${MAX_FILTER_VALUE_BYTES} JSON bytes.`);
    }
    return {
      columnId: filter.columnId,
      op: filter.op,
      ...(needsValue ? { value: filter.value } : {}),
    };
  });
}

function filterSql(description, filters) {
  const columns = columnMap(description);
  const clauses = [];
  const params = [];
  for (const filter of filters) {
    const expression = qualifiedColumn(columns.get(filter.columnId));
    if (filter.op === "is-null") {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    if (filter.op === "not-null") {
      clauses.push(`${expression} IS NOT NULL`);
      continue;
    }
    const value = decodeScalar(filter.value);
    switch (filter.op) {
      case "eq":
        clauses.push(`${expression} IS ?`);
        params.push(value);
        break;
      case "ne":
        clauses.push(`${expression} IS NOT ?`);
        params.push(value);
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const operator = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.op];
        clauses.push(`${expression} ${operator} ?`);
        params.push(value);
        break;
      }
      case "contains":
        clauses.push(`instr(CAST(${expression} AS TEXT), CAST(? AS TEXT)) > 0`);
        params.push(value);
        break;
      case "starts-with":
        clauses.push(
          `substr(CAST(${expression} AS TEXT), 1, length(CAST(? AS TEXT))) = CAST(? AS TEXT)`,
        );
        params.push(value, value);
        break;
    }
  }
  return { clauses, params };
}

function orderTerms(description, sort) {
  const identities = identityExpressions(description).map((expression) => ({
    expression,
    direction: "ASC",
  }));
  if (sort == null) return identities;
  const columns = columnMap(description);
  const column = columns.get(sort.columnId);
  if (!column || !["asc", "desc"].includes(sort.direction)) {
    fail("INVALID_SORT", "Sort refers to an unknown column or direction.");
  }
  const expression = qualifiedColumn(column);
  return [
    { expression: `(${expression} IS NULL)`, direction: "ASC" },
    { expression, direction: sort.direction.toUpperCase() },
    ...identities.filter((term) => term.expression !== expression),
  ];
}

function safeScalarProjection(expression) {
  return [
    `typeof(${expression})`,
    `CASE typeof(${expression})
       WHEN 'text' THEN CASE WHEN length(substr(${expression}, ${CURSOR_VALUE_LIMIT + 1}, 1)) = 0
                             THEN ${expression} ELSE NULL END
       WHEN 'blob' THEN CASE WHEN length(${expression}) <= ${CURSOR_VALUE_LIMIT}
                             THEN ${expression} ELSE NULL END
       ELSE ${expression}
     END`,
    `CASE typeof(${expression})
       WHEN 'text' THEN CASE WHEN length(substr(${expression}, ${CURSOR_VALUE_LIMIT + 1}, 1)) = 0
                             THEN 0 ELSE 1 END
       WHEN 'blob' THEN CASE WHEN length(${expression}) <= ${CURSOR_VALUE_LIMIT}
                             THEN 0 ELSE 1 END
       ELSE 0
     END`,
  ];
}

function gridProjection(expression) {
  return [
    `typeof(${expression})`,
    `CASE typeof(${expression})
       WHEN 'text' THEN substr(${expression}, 1, ${GRID_TEXT_LIMIT})
       WHEN 'blob' THEN length(${expression})
       ELSE ${expression}
     END`,
    `CASE typeof(${expression})
       WHEN 'text' THEN CASE WHEN length(substr(${expression}, ${GRID_TEXT_LIMIT + 1}, 1)) = 0
                             THEN 0 ELSE 1 END
       WHEN 'blob' THEN hex(substr(${expression}, 1, ${GRID_BLOB_PREVIEW_BYTES}))
       ELSE NULL
     END`,
  ];
}

function parseProjectedScalar(row, offset) {
  const type = row[offset];
  const value = row[offset + 1];
  const oversized = Number(row[offset + 2]) === 1;
  return { value: oversized ? null : encodeScalar(value, type), oversized, nextOffset: offset + 3 };
}

function cursorPredicate(terms, values, traversal) {
  if (!Array.isArray(values) || values.length !== terms.length) {
    fail("INVALID_CURSOR", "Cursor does not match the requested ordering.");
  }
  const queryTerms = terms.map((term) => ({
    ...term,
    direction:
      traversal === "previous" ? (term.direction === "ASC" ? "DESC" : "ASC") : term.direction,
  }));
  const clauses = [];
  const params = [];
  for (let index = 0; index < queryTerms.length; index++) {
    const prefix = [];
    for (let previous = 0; previous < index; previous++) {
      prefix.push(`(${queryTerms[previous].expression}) IS ?`);
      params.push(decodeScalar(values[previous]));
    }
    const comparator = queryTerms[index].direction === "ASC" ? ">" : "<";
    prefix.push(`(${queryTerms[index].expression}) ${comparator} ?`);
    params.push(decodeScalar(values[index]));
    clauses.push(`(${prefix.join(" AND ")})`);
  }
  return { clause: `(${clauses.join(" OR ")})`, params, queryTerms };
}

function parseOffset(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    fail("INVALID_CURSOR", "Cursor offset is invalid.");
  }
  const result = BigInt(value);
  if (result > 9223372036854775807n) {
    fail("INVALID_CURSOR", "Cursor offset is outside SQLite's signed 64-bit range.");
  }
  return result;
}

function makeCursor(revision, queryKey, offset, values, oversized) {
  const cursor = {
    v: PROTOCOL_VERSION,
    revision,
    queryKey,
    offset: String(offset),
    mode: oversized ? "offset" : "keyset",
    values: oversized ? [] : values,
  };
  if (jsonBytes(cursor) > MAX_CURSOR_BYTES) {
    cursor.mode = "offset";
    cursor.values = [];
  }
  return cursor;
}

function validateCursor(cursor, revision, queryKey) {
  if (
    cursor == null ||
    cursor.v !== PROTOCOL_VERSION ||
    cursor.revision !== revision ||
    cursor.queryKey !== queryKey ||
    !["keyset", "offset"].includes(cursor.mode) ||
    jsonBytes(cursor) > MAX_CURSOR_BYTES
  ) {
    fail("INVALID_CURSOR", "Cursor is stale or belongs to a different query.");
  }
  parseOffset(cursor.offset);
  return cursor;
}

function sourceSql(description) {
  return `${quoteIdentifier("main")}.${quoteIdentifier(description.name)} AS data`;
}

function planFlags(rows) {
  const details = rows.map((row) => String(row[3] || ""));
  return {
    scan: details.some((detail) => /(^|\s)SCAN\s/i.test(detail)),
    tempSort: details.some((detail) => /USE TEMP B-TREE.*ORDER BY/i.test(detail)),
    indexed: details.some((detail) =>
      /USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY/i.test(detail),
    ),
  };
}

function sameFileIdentity(left, right) {
  if (!left?.exists || !right?.exists) return false;
  if (left.ino !== "0" && right.ino !== "0")
    return left.dev === right.dev && left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

class BrowseEngine {
  constructor(options) {
    this.database = new ReadonlyDatabase(options.path);
    this.revision = Number.isInteger(options.revision) ? options.revision : 1;
    this.dataVersion = this.database.dataVersion();
    this.schemaVersion = this.database.schemaVersion();
    this.fingerprint = this.database.fingerprint();
    this.catalogCache = new Map();
    this.descriptionCache = new Map();
    this.planCache = new Map();
  }

  assertRevision(revision) {
    if (revision !== this.revision) {
      fail("STALE_REVISION", "The database changed; reload this result.", {
        revision: this.revision,
      });
    }
  }

  checkExternal() {
    const fingerprint = this.database.fingerprint();
    if (!fingerprint.main.exists) fail("FILE_DELETED", "The database file was deleted.");
    if (!sameFileIdentity(this.fingerprint.main, fingerprint.main)) {
      fail("FILE_REPLACED", "The database file was replaced and must be reopened.");
    }
    const dataVersion = this.database.dataVersion();
    const schemaVersion = this.database.schemaVersion();
    const changed = dataVersion !== this.dataVersion;
    const schemaChanged = schemaVersion !== this.schemaVersion;
    if (changed || schemaChanged) {
      this.revision++;
      this.catalogCache.clear();
      this.descriptionCache.clear();
      this.planCache.clear();
    }
    this.dataVersion = dataVersion;
    this.schemaVersion = schemaVersion;
    this.fingerprint = fingerprint;
    return { changed: changed || schemaChanged, schemaChanged, revision: this.revision };
  }

  catalog(options = {}) {
    options ||= {};
    const cacheKey = JSON.stringify({
      includeInternal: Boolean(options.includeInternal),
      includeShadow: Boolean(options.includeShadow),
    });
    if (!this.catalogCache.has(cacheKey)) {
      this.catalogCache.set(cacheKey, listObjects(this.database, options));
    }
    return {
      info: databaseInfo(this.database),
      objects: this.catalogCache.get(cacheKey),
      revision: this.revision,
      fingerprint: this.fingerprint,
    };
  }

  describe(name) {
    if (!this.descriptionCache.has(name)) {
      this.descriptionCache.set(name, describeObject(this.database, name));
    }
    return this.descriptionCache.get(name);
  }

  page(request) {
    this.assertRevision(request.revision);
    if (this.checkExternal().changed) this.assertRevision(request.revision);
    if (request.source?.schema !== "main")
      fail("INVALID_SOURCE", "Only the main schema can be browsed.");
    const description = this.describe(request.source?.name);
    if (!description.dataBearing) {
      fail("SOURCE_NOT_BROWSABLE", "Indexes and triggers do not contain rows to browse.");
    }
    const columns = columnMap(description);
    const requestedColumns =
      request.columnIds ?? description.columns.slice(0, MAX_PAGE_COLUMNS).map((c) => c.id);
    if (
      !Array.isArray(requestedColumns) ||
      requestedColumns.length === 0 ||
      requestedColumns.length > MAX_PAGE_COLUMNS ||
      requestedColumns.some((id) => !columns.has(id))
    ) {
      fail("INVALID_COLUMNS", `Select between 1 and ${MAX_PAGE_COLUMNS} known columns.`);
    }
    const limit = Math.min(
      MAX_PAGE_ROWS,
      Math.max(1, Number.isInteger(request.rowLimit) ? request.rowLimit : DEFAULT_PAGE_ROWS),
    );
    const direction = request.direction ?? "first";
    if (!["first", "next", "previous", "last"].includes(direction)) {
      fail("INVALID_DIRECTION", "Unknown page direction.");
    }
    const filters = validateFilters(description, request.filters ?? []);
    const sort = request.sort ?? null;
    const terms = orderTerms(description, sort);
    const queryKey = stableHash({ source: request.source, sort, filters });
    let cursor = null;
    if (direction === "next" || direction === "previous") {
      cursor = validateCursor(request.cursor, this.revision, queryKey);
    }

    const identity = identityExpressions(description);
    const canKeyset = identity.length > 0 && terms.length > 0 && cursor?.mode !== "offset";
    const filter = filterSql(description, filters);
    const where = [...filter.clauses];
    const params = [...filter.params];
    let queryTerms = terms;
    if (canKeyset && cursor != null) {
      const keyset = cursorPredicate(terms, cursor.values, direction);
      where.push(keyset.clause);
      params.push(...keyset.params);
      queryTerms = keyset.queryTerms;
    } else if ((direction === "previous" && canKeyset) || (direction === "last" && canKeyset)) {
      queryTerms = terms.map((term) => ({
        ...term,
        direction: term.direction === "ASC" ? "DESC" : "ASC",
      }));
    }

    const termProjection = terms.flatMap((term) => safeScalarProjection(term.expression));
    const identityProjection = identity.flatMap((expression) => safeScalarProjection(expression));
    const cellProjection = requestedColumns.flatMap((id) =>
      gridProjection(qualifiedColumn(columns.get(id))),
    );
    const projection = [...termProjection, ...identityProjection, ...cellProjection];
    let pageStart = 0n;
    if (direction === "last") {
      const totalRows = parseOffset(request.totalRows);
      pageStart = totalRows > BigInt(limit) ? totalRows - BigInt(limit) : 0n;
    } else if (cursor != null) {
      const cursorOffset = parseOffset(cursor.offset);
      pageStart =
        direction === "previous"
          ? cursorOffset > BigInt(limit)
            ? cursorOffset - BigInt(limit)
            : 0n
          : cursorOffset;
    }

    const useOffset = !canKeyset;
    let sql = `SELECT ${projection.join(", ")} FROM ${sourceSql(description)}`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    if (queryTerms.length > 0) {
      sql += ` ORDER BY ${queryTerms.map((term) => `${term.expression} ${term.direction}`).join(", ")}`;
    }
    sql += " LIMIT ?";
    params.push(BigInt(limit + 1));
    if (useOffset) {
      sql += " OFFSET ?";
      params.push(pageStart);
    }

    const planKey = stableHash({ queryKey, direction, useOffset, requestedColumns });
    if (!this.planCache.has(planKey)) {
      this.planCache.set(
        planKey,
        planFlags(
          this.database.internal((db) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)),
        ),
      );
    }
    let rawRows = this.database.internal((db) => db.prepare(sql).all(...params));
    const extra = rawRows.length > limit;
    if (extra) rawRows = rawRows.slice(0, limit);
    if ((direction === "previous" || direction === "last") && canKeyset) rawRows.reverse();
    if (direction === "previous" && canKeyset && cursor != null) {
      const offset = parseOffset(cursor.offset);
      pageStart = offset > BigInt(rawRows.length) ? offset - BigInt(rawRows.length) : 0n;
    }

    const parsed = [];
    let bytes = 0;
    let limitedByBytes = false;
    for (const raw of rawRows) {
      let offset = 0;
      const orderValues = [];
      let orderOversized = false;
      for (let index = 0; index < terms.length; index++) {
        const value = parseProjectedScalar(raw, offset);
        offset = value.nextOffset;
        orderValues.push(value.value);
        orderOversized ||= value.oversized;
      }
      const rowValues = [];
      let rowOversized = false;
      for (let index = 0; index < identity.length; index++) {
        const value = parseProjectedScalar(raw, offset);
        offset = value.nextOffset;
        rowValues.push(value.value);
        rowOversized ||= value.oversized;
      }
      const cells = [];
      for (let index = 0; index < requestedColumns.length; index++) {
        cells.push(gridCellFromProjection(raw[offset], raw[offset + 1], raw[offset + 2]));
        offset += 3;
      }
      let rowKey = null;
      if (identity.length > 0 && !rowOversized) {
        const candidate = {
          v: PROTOCOL_VERSION,
          revision: this.revision,
          source: request.source,
          values: rowValues,
        };
        if (jsonBytes(candidate) <= MAX_CURSOR_BYTES) rowKey = candidate;
      }
      const row = { rowKey, cells };
      const rowBytes = jsonBytes(row);
      if (parsed.length > 0 && bytes + rowBytes > MAX_PAGE_BYTES) {
        limitedByBytes = true;
        break;
      }
      bytes += rowBytes;
      parsed.push({ row, orderValues, orderOversized });
    }

    const first = parsed[0];
    const last = parsed.at(-1);
    const before =
      first == null
        ? null
        : makeCursor(
            this.revision,
            queryKey,
            pageStart,
            first.orderValues,
            first.orderOversized || !canKeyset,
          );
    const afterOffset = pageStart + BigInt(parsed.length);
    const after =
      last == null
        ? null
        : makeCursor(
            this.revision,
            queryKey,
            afterOffset,
            last.orderValues,
            last.orderOversized || !canKeyset,
          );
    const afterCheck = this.checkExternal();
    if (afterCheck.changed) fail("STALE_REVISION", "Database changed while the page was loading.");
    const executionPlan = this.planCache.get(planKey);

    return {
      columns: requestedColumns.map((id) => columns.get(id)),
      rows: parsed.map((entry) => entry.row),
      before,
      after,
      hasPrevious: pageStart > 0n,
      hasNext: direction === "last" ? false : extra || limitedByBytes || direction === "previous",
      pagination:
        canKeyset && !first?.orderOversized && !last?.orderOversized ? "keyset" : "offset",
      stable: identity.length > 0,
      degraded: useOffset || first?.orderOversized === true || last?.orderOversized === true,
      limitedByBytes,
      planFlags: {
        ...executionPlan,
        potentiallySlow: executionPlan.tempSort || (executionPlan.scan && filters.length > 0),
      },
      revision: this.revision,
    };
  }

  cell(request) {
    this.assertRevision(request.revision);
    if (request.source?.schema !== "main")
      fail("INVALID_SOURCE", "Only the main schema can be browsed.");
    const description = this.describe(request.source?.name);
    if (!description.dataBearing) {
      fail("SOURCE_NOT_BROWSABLE", "Indexes and triggers do not contain cells to inspect.");
    }
    const columns = columnMap(description);
    const column = columns.get(request.columnId);
    if (!column) fail("INVALID_COLUMN", "Cell refers to an unknown column.");
    const identity = identityExpressions(description);
    const key = request.rowKey;
    if (
      identity.length === 0 ||
      key?.v !== PROTOCOL_VERSION ||
      key.revision !== this.revision ||
      key.source?.name !== description.name ||
      key.source?.schema !== "main" ||
      !Array.isArray(key.values) ||
      key.values.length !== identity.length ||
      jsonBytes(key) > MAX_CURSOR_BYTES
    ) {
      fail("INVALID_ROW_KEY", "This row does not have a usable stable identity.");
    }
    const expression = qualifiedColumn(column);
    const sql = `SELECT typeof(${expression}),
                        CASE typeof(${expression})
                          WHEN 'text' THEN substr(${expression}, 1, ${CELL_TEXT_LIMIT})
                          WHEN 'blob' THEN substr(${expression}, 1, ${CELL_BLOB_LIMIT})
                          ELSE ${expression}
                        END,
                        CASE typeof(${expression})
                          WHEN 'text' THEN CASE WHEN length(substr(${expression}, ${CELL_TEXT_LIMIT + 1}, 1)) = 0 THEN 0 ELSE 1 END
                          WHEN 'blob' THEN length(${expression})
                          ELSE NULL
                        END
                   FROM ${sourceSql(description)}
                  WHERE ${identity.map((item) => `${item} IS ?`).join(" AND ")}
                  LIMIT 1`;
    const row = this.database.internal((db) =>
      db.prepare(sql).get(...key.values.map(decodeScalar)),
    );
    if (!row) fail("ROW_NOT_FOUND", "The selected row no longer exists.");
    const [type, value, extra] = row;
    if (type === "blob") {
      const buffer = Buffer.from(value);
      const byteLength = BigInt(extra);
      return {
        type,
        byteLength: String(byteLength),
        base64: buffer.toString("base64"),
        truncated: byteLength > BigInt(buffer.length),
      };
    }
    if (type === "text") return { type, value, truncated: Number(extra) === 1 };
    return { type, value: encodeScalar(value, type), truncated: false };
  }

  count(request) {
    this.assertRevision(request.revision);
    if (request.source?.schema !== "main")
      fail("INVALID_SOURCE", "Only the main schema can be browsed.");
    const description = this.describe(request.source?.name);
    if (!description.dataBearing) {
      fail("SOURCE_NOT_BROWSABLE", "Indexes and triggers do not contain rows to count.");
    }
    const filters = validateFilters(description, request.filters ?? []);
    const filter = filterSql(description, filters);
    let sql = `SELECT count(*) FROM ${sourceSql(description)}`;
    if (filter.clauses.length > 0) sql += ` WHERE ${filter.clauses.join(" AND ")}`;
    const before = this.database.dataVersion();
    const count = this.database.internal((db) => db.prepare(sql).get(...filter.params)[0]);
    if (this.database.dataVersion() !== before) {
      fail("STALE_REVISION", "Database changed while rows were being counted.");
    }
    return { count: String(count), revision: this.revision };
  }

  close() {
    this.database.close();
  }
}

module.exports = {
  BrowseEngine,
  filterSql,
  identityExpressions,
  orderTerms,
  validateFilters,
};
