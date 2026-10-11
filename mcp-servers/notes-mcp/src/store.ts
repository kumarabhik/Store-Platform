import { DatabaseSync } from "node:sqlite";

// Notes live in SQLite on a PVC. Node's built-in node:sqlite needs no native addon, so the image
// has no build toolchain and tests run on any Node >= 22.13 (unlike better-sqlite3, SYSTEM.md L13).

export interface Note {
  id: number;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

interface Row {
  id: number;
  title: string;
  body: string;
  tags: string;
  created_at: string;
}

const toNote = (r: Row): Note => ({ id: r.id, title: r.title, body: r.body, tags: JSON.parse(r.tags) as string[], created_at: r.created_at });

// LIKE treats % and _ as wildcards; escape them so a search for "100%" means exactly that.
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null,
      body text not null,
      tags text not null default '[]',
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    create index if not exists idx_notes_created on notes(created_at desc);
  `);

  return {
    add(title: string, body: string, tags: string[]): Note {
      const r = db.prepare(`insert into notes (title, body, tags) values (?, ?, ?) returning *`).get(title, body, JSON.stringify(tags)) as unknown as Row;
      return toNote(r);
    },

    list(limit: number, tag?: string): Note[] {
      const rows = tag
        ? db.prepare(`select n.* from notes n where exists (select 1 from json_each(n.tags) where value = ?) order by n.id desc limit ?`).all(tag, limit)
        : db.prepare(`select * from notes order by id desc limit ?`).all(limit);
      return (rows as unknown as Row[]).map(toNote);
    },

    search(query: string, limit: number): Note[] {
      const p = likePattern(query);
      const rows = db.prepare(`select * from notes where title like ? escape '\\' or body like ? escape '\\' order by id desc limit ?`).all(p, p, limit);
      return (rows as unknown as Row[]).map(toNote);
    },

    ping(): void {
      db.prepare(`select 1`).get();
    },

    close: () => db.close(),
  };
}

export type NoteStore = ReturnType<typeof openStore>;
