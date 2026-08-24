"use strict";

const path = require("node:path");
const constants = require("./constants");
const { decodeScalar, encodeScalar } = require("./values");

module.exports = {
  BrowseEngine: require("./browse-engine").BrowseEngine,
  ReadonlyDatabase: require("./readonly-database").ReadonlyDatabase,
  runQuery: require("./query-runner").runQuery,
  constants,
  decodeScalar,
  encodeScalar,
  browseTaskPath: path.join(__dirname, "browse-task.js"),
  queryTaskPath: path.join(__dirname, "query-task.js"),
  countTaskPath: path.join(__dirname, "count-task.js"),
};
