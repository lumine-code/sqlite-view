"use strict";

const { Buffer } = require("node:buffer");
const { fail } = require("./errors");

function realToString(value) {
  if (Object.is(value, -0)) return "-0";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

function encodeScalar(value, sqliteType = null) {
  if (value == null || sqliteType === "null") return null;
  if (typeof value === "bigint" || sqliteType === "integer") return ["i", String(value)];
  if (typeof value === "number" || sqliteType === "real") return ["r", realToString(value)];
  if (typeof value === "string" || sqliteType === "text") return ["t", String(value)];
  if (ArrayBuffer.isView(value) || sqliteType === "blob") {
    return ["b", Buffer.from(value).toString("base64")];
  }
  fail("UNSUPPORTED_VALUE", `Unsupported SQLite value of type ${typeof value}.`);
}

function decodeScalar(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") {
    fail("INVALID_VALUE", "Expected a tagged SQLite scalar value.");
  }
  switch (value[0]) {
    case "i": {
      if (!/^-?\d+$/.test(value[1])) fail("INVALID_VALUE", "Invalid integer value.");
      const result = BigInt(value[1]);
      if (result < -9223372036854775808n || result > 9223372036854775807n) {
        fail("INVALID_VALUE", "Integer is outside SQLite's signed 64-bit range.");
      }
      return result;
    }
    case "r":
      if (value[1] === "Infinity") return Infinity;
      if (value[1] === "-Infinity") return -Infinity;
      if (value[1] === "-0") return -0;
      if (
        typeof value[1] !== "string" ||
        value[1].trim() === "" ||
        Number.isNaN(Number(value[1]))
      ) {
        fail("INVALID_VALUE", "Invalid real value.");
      }
      return Number(value[1]);
    case "t":
      if (typeof value[1] !== "string") fail("INVALID_VALUE", "Invalid text value.");
      return value[1];
    case "b":
      if (typeof value[1] !== "string") fail("INVALID_VALUE", "Invalid BLOB value.");
      return Buffer.from(value[1], "base64");
    default:
      fail("INVALID_VALUE", `Unknown SQLite value tag ${JSON.stringify(value[0])}.`);
  }
}

function gridCell(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return ["i", String(value)];
  if (typeof value === "number") return ["r", realToString(value)];
  if (typeof value === "string") {
    const prefix = value.slice(0, 4096);
    return ["t", prefix, value.length > prefix.length ? 1 : 0];
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return ["b", String(buffer.length), buffer.subarray(0, 16).toString("hex")];
  }
  fail("UNSUPPORTED_VALUE", `Unsupported SQLite result of type ${typeof value}.`);
}

function gridCellFromProjection(sqliteType, value, extra) {
  switch (sqliteType) {
    case "null":
      return null;
    case "integer":
      return ["i", String(value)];
    case "real":
      return ["r", realToString(value)];
    case "text":
      return ["t", value ?? "", Number(extra) === 1 ? 1 : 0];
    case "blob":
      return ["b", String(value), extra ?? ""];
    default:
      return gridCell(value);
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

module.exports = {
  decodeScalar,
  encodeScalar,
  gridCell,
  gridCellFromProjection,
  jsonBytes,
  realToString,
};
