const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const parse = (relativePath) => JSON.parse(read(relativePath));
const manifest = parse("package.json");

const DESCRIPTION = "Browse SQLite databases in a fast, keyboard-driven grid.";
const PUBLIC_COMMANDS = [
  "sqlite-view:execute-query",
  "sqlite-view:cancel-query",
  "sqlite-view:refresh",
  "sqlite-view:focus-schema",
  "sqlite-view:focus-query",
  "sqlite-view:focus-grid",
];

function filesBelow(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(filePath));
    else result.push(filePath);
  }
  return result;
}

function menuCommands(items, result = []) {
  for (const item of items) {
    if (item.command) result.push(item.command);
    if (item.submenu) menuCommands(item.submenu, result);
  }
  return result;
}

describe("sqlite-view package assets", () => {
  it("uses the canonical package identity and eager activation", () => {
    expect(manifest.name).toBe("sqlite-view");
    expect(manifest.author).toBe("lumine-code");
    expect(manifest.description).toBe(DESCRIPTION);
    expect(manifest.repository).toBe("https://github.com/lumine-code/sqlite-view");
    expect(manifest.bugs.url).toBe("https://github.com/lumine-code/sqlite-view/issues");
    expect(manifest.engines).toEqual({ lumine: "^1.0.0" });
    expect(manifest.activationCommands).toBeUndefined();
    expect(manifest.configSchema).toEqual({
      additionalExtensions: {
        title: "Additional Database Extensions",
        description:
          "Additional filename extensions to inspect for a SQLite header. Enter each value with or without a leading dot, for example `data` or `.sqlite.backup`.",
        type: "array",
        items: { type: "string" },
        default: [],
      },
    });
    expect(manifest.deserializers).toEqual({ SQLiteView: "deserialize" });
    expect(manifest.providedServices).toBeUndefined();
    expect(manifest.dependencies).toEqual({
      "@lumine-code/etch": "github:lumine-code/etch#df06b3fca2ec49b1d6b76cb8af3e9f5015a2612c",
    });

    const keys = Object.keys(manifest);
    expect(keys[keys.indexOf("engines") + 1]).toBe("backgroundTips");
    expect(manifest.backgroundTips).toEqual([
      "Run the current database query with {{ 'sqlite-view:execute-query' | keystroke }}",
    ]);
  });

  it("keeps the README and package metadata descriptions identical", () => {
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# sqlite-view");
    expect(lines[2]).toBe(DESCRIPTION);
    expect(lines).toContain(
      "To install `sqlite-view` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/sqlite-view`.",
    );
  });

  it("uses searchable, non-redundant keywords", () => {
    const filler = new Set([
      "lumine",
      "editor",
      "package",
      "plugin",
      "extension",
      "tool",
      "utility",
      "code",
      "visual",
      "ui",
    ]);
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
    for (const keyword of manifest.keywords) {
      expect(keyword).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(manifest.name.includes(keyword)).toBe(false);
      expect(filler.has(keyword)).toBe(false);
    }
  });

  it("ships every runtime asset and the specs", () => {
    expect(manifest.files).toEqual(["keymaps", "lib", "menus", "spec", "styles"]);
    expect(manifest.scripts.test).toBe("lumine --test spec");
    expect(fs.readdirSync(path.join(root, "keymaps"))).toEqual(["main.json"]);
    expect(fs.readdirSync(path.join(root, "menus"))).toEqual(["main.json"]);
    expect(fs.readdirSync(path.join(root, "styles"))).toEqual(["main.css"]);
    expect(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml"))).toBe(true);
    expect(read("lib/main.js")).toContain("etch.setScheduler(lumine.views)");
  });

  it("keeps the six public commands flat and in task order", () => {
    const menu = parse("menus/main.json");
    expect(Object.keys(menu)).toEqual(["menu"]);
    const packages = menu.menu.find((item) => item.label === "Packages");
    const submenu = packages.submenu.find((item) => item.label === "SQLite View");
    expect(submenu.submenu.length).toBe(6);
    expect(submenu.submenu.some((item) => item.type === "separator")).toBe(false);
    expect(submenu.submenu.map((item) => item.label)).toEqual([
      "Execute Query",
      "Cancel Query",
      "Refresh",
      "Focus Schema",
      "Focus Query",
      "Focus Grid",
    ]);
    expect(menuCommands(menu.menu)).toEqual(PUBLIC_COMMANDS);
  });

  it("scopes every key binding to the view and covers grid navigation", () => {
    const keymap = parse("keymaps/main.json");
    for (const selector of Object.keys(keymap)) {
      expect(selector).toContain(".sqlite-view");
      expect(selector).not.toBe("lumine-workspace");
    }

    expect(keymap[".sqlite-view"].f5).toBe("sqlite-view:refresh");
    const schema = keymap[".sqlite-view-sidebar"];
    expect(schema.f6).toBe("sqlite-view:focus-query");
    expect(schema["shift-f6"]).toBe("sqlite-view:focus-grid");
    const objects = keymap[".sqlite-view-object-list"];
    expect(objects.up).toBe("core:move-up");
    expect(objects.down).toBe("core:move-down");
    expect(objects.left).toBe("core:move-left");
    expect(objects.right).toBe("core:move-right");
    expect(objects.enter).toBe("core:confirm");
    const query = keymap[".sqlite-view-query-editor lumine-text-editor:not([mini])"];
    expect(query["cmdorctrl-enter"]).toBe("sqlite-view:execute-query");
    expect(query.f6).toBe("sqlite-view:focus-grid");
    expect(query["shift-f6"]).toBe("sqlite-view:focus-schema");
    expect(keymap[".sqlite-view-query-resizer"]).toBeUndefined();

    const grid = keymap[".sqlite-view-grid"];
    expect(grid.up).toBe("core:move-up");
    expect(grid["shift-right"]).toBe("core:select-right");
    expect(grid.pageup).toBe("sqlite-view:grid-page-up");
    expect(grid["cmdorctrl-end"]).toBe("core:move-to-bottom");
    expect(grid["shift-space"]).toBe("sqlite-view:grid-select-row");
    expect(grid["ctrl-space"]).toBe("sqlite-view:grid-select-column");
    expect(grid.f6).toBe("sqlite-view:focus-schema");
    expect(grid["shift-f6"]).toBe("sqlite-view:focus-query");
    expect(Object.values(keymap).flatMap(Object.values)).not.toContain("sqlite-view:cancel-query");
  });

  it("names only commands implemented by the package", () => {
    const source = filesBelow(path.join(root, "lib"))
      .filter((filePath) => filePath.endsWith(".js"))
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    const implemented = new Set(
      [...source.matchAll(/["'](sqlite-view:[a-z0-9-]+)["']/g)].map((match) => match[1]),
    );
    const keymapCommands = Object.values(parse("keymaps/main.json")).flatMap(Object.values);
    const named = new Set([
      ...menuCommands(parse("menus/main.json").menu),
      ...keymapCommands.filter((command) => command.startsWith("sqlite-view:")),
    ]);

    for (const command of named) expect(implemented.has(command)).toBe(true);
    expect(source).not.toContain("sqlite-view:toggle");
  });

  it("publishes the canvas sizing and semantic colour hooks", () => {
    const css = read("styles/main.css");
    expect(css).toContain(".sqlite-view {");
    expect(css).toContain("--sqlite-view-row-height:");
    expect(css).toContain("--sqlite-view-header-height:");
    expect(css).toContain("--sqlite-view-accent-color:");
    expect(css).toContain("--sqlite-view-null-color:");
    expect(css).toContain(".sqlite-view-grid-canvas");
    expect(css).toContain(".sqlite-view-object:not(.selected):hover");
    expect(css).toContain("border-radius: var(--component-border-radius);");
    expect(css).toContain(".sqlite-view-query-error");
    expect(css).toContain(".sqlite-view-layout.is-query-mode");
    expect(css).toContain(".sqlite-view-refresh");
    expect(css).toContain("max-height: 10em;");
    expect(css).not.toContain("--sqlite-view-query-editor-height");
    expect(css).not.toContain(".sqlite-view-query-resizer");
    expect(css).not.toContain(".sqlite-view-query-editor:focus-within");
    expect(css).not.toContain(".sqlite-view-sidebar-resizer:hover");
    expect(css).toContain("background: var(--background-color-highlight);");
    expect(css).toContain("cursor: default;");
    expect(css).not.toContain("--tool-panel-background-color");
    expect(css).not.toContain("@import");
  });

  it("keeps JSON assets free of trailing commas", () => {
    expect(read("keymaps/main.json")).not.toMatch(/,\s*[}\]]/);
    expect(read("menus/main.json")).not.toMatch(/,\s*[}\]]/);
  });
});
