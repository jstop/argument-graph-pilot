// A JSON file as a database. Whole-file atomic rewrite on every change,
// single process, no concurrency control. Chosen so a person cloning the
// pilot can open the file and read it. Not a production store (DESIGN.md).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T> {
  private data: T;

  constructor(private readonly path: string, initial: T) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : initial;
  }

  get value(): T {
    return this.data;
  }

  update(mutate: (data: T) => void): void {
    mutate(this.data);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
