function statementAt(text, index) {
  const statements = splitStatements(text);
  const containing = statements.find(
    ({ start, end }) => index >= start && (index < end || (index === end && end === text.length)),
  );
  const nearest = containing || statements.find(({ start }) => start >= index) || statements.at(-1);
  return nearest?.text.trim() || "";
}

function splitStatements(text) {
  const statements = [];
  let start = 0;
  let state = "plain";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "plain";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "plain";
        i += 1;
      }
      continue;
    }
    if (state === "single") {
      if (char === "'" && next === "'") i += 1;
      else if (char === "'") state = "plain";
      continue;
    }
    if (state === "double") {
      if (char === '"' && next === '"') i += 1;
      else if (char === '"') state = "plain";
      continue;
    }
    if (state === "backtick") {
      if (char === "`" && next === "`") i += 1;
      else if (char === "`") state = "plain";
      continue;
    }
    if (state === "bracket") {
      if (char === "]" && next === "]") i += 1;
      else if (char === "]") state = "plain";
      continue;
    }
    if (char === "-" && next === "-") {
      state = "line-comment";
      i += 1;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      i += 1;
    } else if (char === "'") {
      state = "single";
    } else if (char === '"') {
      state = "double";
    } else if (char === "`") {
      state = "backtick";
    } else if (char === "[") {
      state = "bracket";
    } else if (char === ";") {
      const value = text.slice(start, i + 1);
      if (value.trim()) statements.push({ start, end: i + 1, text: value });
      start = i + 1;
    }
  }
  const value = text.slice(start);
  if (value.trim()) statements.push({ start, end: text.length, text: value });
  return statements;
}

module.exports = { splitStatements, statementAt };
