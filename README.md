# sqlite-view

Browse SQLite databases in a fast, keyboard-driven grid.

## Features

- **Database browsing**: opens `.sqlite`, `.sqlite3`, `.db`, and `.db3` files in a dedicated workspace tab.
- **Schema explorer**: lists tables, views, indexes, triggers, and columns, with a toggle for SQLite's internal objects.
- **Canvas grid**: draws only the visible rows and columns instead of building a DOM table.
- **Keyboard navigation**: moves and extends the active cell selection by cell, page, row, column, or table boundary.
- **Read-only queries**: runs `SELECT`, read-only `WITH`, `VALUES`, and `EXPLAIN QUERY PLAN` statements in an embedded query editor and lets long work be cancelled.
- **Bounded reads**: pages through results and keeps fixed row and visible-column caches around the viewport, independent of database size.
- **Clipboard export**: copies the selected cells as tab-separated text for pasting into a spreadsheet or text editor.
- **Navigation integration**: exposes database tables and views as headers when navigation-panel is installed.

## Installation

To install `sqlite-view` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/sqlite-view`.

## Commands

Commands available in `lumine-workspace`:

- `sqlite-view:execute-query`: run the statement in the query editor,
- `sqlite-view:cancel-query`: interrupt the query that is currently running,
- `sqlite-view:refresh`: read the database schema and visible data again,
- `sqlite-view:focus-schema`: move focus to the schema explorer,
- `sqlite-view:focus-query`: move focus to the query editor,
- `sqlite-view:focus-grid`: move focus to the result grid.

## Usage

The package opens databases read-only. Browsing, sorting, filtering, and running a query never write to the file; statements that could modify the database are refused before they run.

Selecting a table or view loads its columns and the first page of rows. SQLite's own `sqlite_*` objects stay hidden until the system-object toggle is enabled, and refreshing re-reads both the schema and the visible result after another program changes the file.

The grid keeps one active cell and rectangular selections. Navigation scrolls that cell into view without materializing rows outside the bounded page cache, and copying emits tab-separated rows without formatting values into HTML.

## Customization

Add non-standard filename extensions with **Additional Database Extensions** in the package settings. Values may include or omit the leading dot, and SQLite View still verifies the SQLite header before opening a matching file.

Adjust row density and the grid's semantic colours in your `styles.css`:

```css
.sqlite-view {
  --sqlite-view-row-height: 22px;
  --sqlite-view-header-height: 26px;
  --sqlite-view-accent-color: var(--text-color-info);
  --sqlite-view-null-color: var(--text-color-subtle);
}
```

## Services

- `navigation.adapter`: provided to expose database objects and columns as navigation headers.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
