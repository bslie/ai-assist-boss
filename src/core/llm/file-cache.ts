import { promises as fs } from "node:fs";
import path from "node:path";
import type { LlmCache } from "./index";

/** Файловый кэш для eval (`tests/fixtures/llm-cache.json`): без сети при попадании. */
export class FileCache implements LlmCache {
  private data: Record<string, unknown> | null = null;
  constructor(private readonly file: string, private readonly refresh = false) {}

  private async load(): Promise<Record<string, unknown>> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async get(key: string) {
    if (this.refresh) return undefined;
    return (await this.load())[key];
  }

  async set(key: string, value: unknown) {
    const data = await this.load();
    data[key] = value;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
  }
}
