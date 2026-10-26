const MAX_QUERY_UNITS = 1024 * 1024;
const pause = () => new Promise((resolve) => setImmediate(resolve));

function checkQueryLength(length) {
  if (length > MAX_QUERY_UNITS)
    throw new RangeError(
      "A SQLite query is limited to 1 Mi UTF-16 units. Select a smaller statement.",
    );
}

async function statementAtSource(source, cursor, { signal, isCurrent } = {}) {
  const read = source.reader(4096);
  let cached = "",
    cachedStart = -1;
  const character = (index) => {
    if (index >= source.length) return "";
    if (index < cachedStart || index >= cachedStart + cached.length) {
      cachedStart = index;
      cached = read(index);
    }
    return cached[index - cachedStart];
  };
  const check = () => {
    if (signal?.aborted || isCurrent?.() === false)
      throw Object.assign(new Error("Query preparation cancelled"), { name: "AbortError" });
  };
  let start = 0,
    first = -1,
    last = 0,
    state = "plain",
    previous = null,
    deadline = performance.now() + 4,
    nextCheck = 0;
  const materialize = (range) => {
    if (!range) return "";
    checkQueryLength(range.last - range.first);
    return source.slice(range.first, range.last);
  };
  for (let i = 0; i < source.length; i++) {
    if (i >= nextCheck) {
      nextCheck = i + 4096;
      check();
      if (performance.now() >= deadline) {
        await pause();
        check();
        deadline = performance.now() + 4;
      }
    }
    const char = character(i),
      next = character(i + 1);
    if (/\S/.test(char)) {
      if (first < 0) first = i;
      last = i + 1;
    }
    let skip = false,
      complete = false;
    if (state === "line-comment") {
      if (char === "\n") state = "plain";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "plain";
        skip = true;
      }
    } else if (state !== "plain") {
      const delimiter = { single: "'", double: '"', backtick: "`", bracket: "]" }[state];
      if (char === delimiter && next === delimiter) skip = true;
      else if (char === delimiter) state = "plain";
    } else if (char === "-" && next === "-") {
      state = "line-comment";
      skip = true;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      skip = true;
    } else if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "backtick";
    else if (char === "[") state = "bracket";
    else if (char === ";") complete = true;
    if (skip) {
      i++;
      last = i + 1;
    }
    if (complete) {
      const range = { start, end: i + 1, first, last };
      if (cursor < range.end || (cursor === range.end && range.end === source.length))
        return materialize(range);
      previous = range;
      start = i + 1;
      first = -1;
    }
  }
  check();
  return materialize(first < 0 ? previous : { start, end: source.length, first, last });
}

module.exports = { statementAtSource, checkQueryLength, MAX_QUERY_UNITS };
