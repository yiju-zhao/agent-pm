import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchV2 } from '../shared/ingest-v2.ts';
import { writeFileAtomic } from './state-store.ts';

/**
 * Batches written before they are sent, removed once the center acknowledged them. A crash anywhere between building
 * a batch and its acknowledgement leaves the batch here, and it is resent byte for byte (the center answers a repeat
 * with the original acknowledgement). Per agent, files sort in the order they were written.
 */
export class Outbox {
  readonly dir: string;
  private counter = Date.now();

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'outbox');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private agentDir(agentId: string): string {
    return join(this.dir, encodeURIComponent(agentId));
  }

  /** Durably stores a batch; returns its file. */
  put(batch: BatchV2): string {
    const dir = this.agentDir(batch.agent_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${String(++this.counter).padStart(16, '0')}-${batch.batch_id}.json`);
    writeFileAtomic(file, JSON.stringify(batch));
    return file;
  }

  /** An agent's pending batches, oldest first. Unreadable files (a torn write cannot happen, but a hand edit can) are skipped. */
  pending(agentId: string): Array<{ file: string; batch: BatchV2 }> {
    const dir = this.agentDir(agentId);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: Array<{ file: string; batch: BatchV2 }> = [];
    for (const name of names) {
      try {
        out.push({ file: join(dir, name), batch: JSON.parse(readFileSync(join(dir, name), 'utf8')) as BatchV2 });
      } catch {
        // skipped; left in place for inspection
      }
    }
    return out;
  }

  /** Agents with pending batches. */
  agents(): string[] {
    try {
      return readdirSync(this.dir)
        .map((n) => decodeURIComponent(n))
        .filter((id) => this.pending(id).length > 0);
    } catch {
      return [];
    }
  }

  remove(file: string): void {
    rmSync(file, { force: true });
  }

  /** Bytes and files pending, across all agents. */
  usage(): { bytes: number; batches: number } {
    let bytes = 0;
    let batches = 0;
    for (const agent of readdirSync(this.dir)) {
      const dir = join(this.dir, agent);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        bytes += statSync(join(dir, name)).size;
        batches += 1;
      }
    }
    return { bytes, batches };
  }
}
