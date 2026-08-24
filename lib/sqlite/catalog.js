"use strict";

const { quoteIdentifier } = require("./sql");
const { fail } = require("./errors");

const HIDDEN_KINDS = ["normal", "hidden", "generated-virtual", "generated-stored"];

function toNumber(value) {
  return Number(value);
}

function databaseInfo(database) {
  return database.internal((db) => ({
    applicationId: String(db.prepare("PRAGMA application_id").get()[0]),
    userVersion: String(db.prepare("PRAGMA user_version").get()[0]),
    encoding: String(db.prepare("PRAGMA encoding").get()[0]),
    sqliteVersion: String(db.prepare("SELECT sqlite_version()").get()[0]),
  }));
}

function estimates(database) {
  try {
    return database.internal((db) => {
      const result = new Map();
      for (const [table, _index, stat] of db
        .prepare("SELECT tbl, idx, stat FROM main.sqlite_stat1")
        .all()) {
        const match = /^(\d+)/.exec(stat || "");
        if (!match) continue;
        const estimate = BigInt(match[1]);
        if (!result.has(table) || estimate > result.get(table)) result.set(table, estimate);
      }
      return result;
    });
  } catch (error) {
    if (/no such table.*sqlite_stat1/i.test(error?.message || "")) return new Map();
    throw error;
  }
}

function listObjects(database, options = {}) {
  options ||= {};
  const rowEstimates = estimates(database);
  return database.internal((db) => {
    const dataObjects = db
      .prepare(
        `SELECT p.name, p.type, p.ncol, p.wr, p.strict,
                substr(s.sql, 1, 65536),
                CASE WHEN length(substr(s.sql, 65537, 1)) > 0 THEN 1 ELSE 0 END
           FROM pragma_table_list AS p
           LEFT JOIN main.sqlite_schema AS s
             ON s.name = p.name AND s.type IN ('table', 'view')
          WHERE p.schema = 'main'
          ORDER BY lower(p.name), p.name`,
      )
      .all();
    const schemaObjects = db
      .prepare(
        `SELECT name, type, tbl_name, substr(sql, 1, 65536),
                CASE WHEN length(substr(sql, 65537, 1)) > 0 THEN 1 ELSE 0 END
           FROM main.sqlite_schema
          WHERE type IN ('index', 'trigger')`,
      )
      .all()
      .map(([name, type, table, sql, truncated]) => ({
        name,
        type,
        table,
        columns: 0,
        withoutRowid: false,
        strict: false,
        sql,
        sqlTruncated: Boolean(toNumber(truncated)),
        estimatedRows: null,
        dataBearing: false,
      }));

    const objects = dataObjects
      .filter(([name, type]) => {
        if (!options.includeInternal && name.startsWith("sqlite_")) return false;
        if (!options.includeShadow && type === "shadow") return false;
        return true;
      })
      .map(([name, type, columns, withoutRowid, strict, sql, truncated]) => ({
        name,
        type,
        columns: toNumber(columns),
        withoutRowid: Boolean(toNumber(withoutRowid)),
        strict: Boolean(toNumber(strict)),
        sql: sql ?? null,
        sqlTruncated: Boolean(toNumber(truncated)),
        estimatedRows: rowEstimates.has(name) ? String(rowEstimates.get(name)) : null,
        dataBearing: type !== "shadow",
      }));
    for (const object of schemaObjects) {
      if (!options.includeInternal && object.name.startsWith("sqlite_")) continue;
      objects.push(object);
    }
    return objects.sort((left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "base" }),
    );
  });
}

function objectSummary(database, name) {
  const object = listObjects(database, { includeInternal: true, includeShadow: true }).find(
    (entry) => entry.name === name,
  );
  if (!object) fail("UNKNOWN_OBJECT", `No schema object named ${JSON.stringify(name)} exists.`);
  return object;
}

function listColumns(database, name) {
  return database.internal((db) =>
    db
      .prepare(
        `SELECT cid, name, type, "notnull", dflt_value, pk, hidden
           FROM pragma_table_xinfo(?)
          ORDER BY cid`,
      )
      .all(name)
      .map(([id, columnName, declaredType, notNull, defaultSql, primaryKey, hidden]) => ({
        id: toNumber(id),
        name: columnName,
        declaredType: declaredType || "",
        notNull: Boolean(toNumber(notNull)),
        defaultSql,
        primaryKey: toNumber(primaryKey),
        hidden: HIDDEN_KINDS[toNumber(hidden)] || "hidden",
      })),
  );
}

function listIndexes(database, tableName) {
  return database.internal((db) => {
    const indexes = db
      .prepare('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY seq')
      .all(tableName);
    const sqlStatement = db.prepare(
      "SELECT substr(sql, 1, 65536), CASE WHEN length(substr(sql, 65537, 1)) > 0 THEN 1 ELSE 0 END FROM main.sqlite_schema WHERE type = 'index' AND name = ?",
    );
    const xinfoStatement = db.prepare(
      'SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno',
    );
    return indexes.map(([_sequence, name, unique, origin, partial]) => {
      const sql = sqlStatement.get(name) || [null, 0n];
      return {
        name,
        unique: Boolean(toNumber(unique)),
        origin,
        partial: Boolean(toNumber(partial)),
        sql: sql[0],
        sqlTruncated: Boolean(toNumber(sql[1])),
        columns: xinfoStatement
          .all(name)
          .map(([sequence, columnId, columnName, descending, collation, key]) => ({
            sequence: toNumber(sequence),
            columnId: toNumber(columnId),
            name: columnName,
            descending: Boolean(toNumber(descending)),
            collation,
            key: Boolean(toNumber(key)),
          })),
      };
    });
  });
}

function listForeignKeys(database, tableName) {
  return database.internal((db) =>
    db
      .prepare(
        `SELECT id, seq, "table", "from", "to", on_update, on_delete, "match"
           FROM pragma_foreign_key_list(?)
          ORDER BY id, seq`,
      )
      .all(tableName)
      .map(([id, sequence, table, from, to, onUpdate, onDelete, match]) => ({
        id: toNumber(id),
        sequence: toNumber(sequence),
        table,
        from,
        to,
        onUpdate,
        onDelete,
        match,
      })),
  );
}

function identityFor(object, columns) {
  if (!["table", "virtual"].includes(object.type)) return { mode: "offset", columnIds: [] };
  if (object.withoutRowid) {
    const ids = columns
      .filter((column) => column.primaryKey > 0)
      .sort((left, right) => left.primaryKey - right.primaryKey)
      .map((column) => column.id);
    return ids.length > 0
      ? { mode: "primary-key", columnIds: ids }
      : { mode: "offset", columnIds: [] };
  }

  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  const alias = ["rowid", "_rowid_", "oid"].find((candidate) => !names.has(candidate));
  return alias == null
    ? { mode: "offset", columnIds: [] }
    : { mode: "rowid", alias, columnIds: [] };
}

function describeObject(database, name) {
  if (typeof name !== "string" || name === "")
    fail("INVALID_OBJECT", "An object name is required.");
  const object = objectSummary(database, name);
  if (!object.dataBearing) {
    return {
      ...object,
      columns: [],
      indexes: [],
      foreignKeys: [],
      identity: { mode: "offset", columnIds: [] },
      quotedName: `${quoteIdentifier("main")}.${quoteIdentifier(name)}`,
    };
  }
  const columns = listColumns(database, name);
  return {
    ...object,
    columns,
    indexes: object.type === "view" ? [] : listIndexes(database, name),
    foreignKeys: object.type === "view" ? [] : listForeignKeys(database, name),
    identity: identityFor(object, columns),
    quotedName: `${quoteIdentifier("main")}.${quoteIdentifier(name)}`,
  };
}

module.exports = {
  databaseInfo,
  describeObject,
  identityFor,
  listColumns,
  listObjects,
};
