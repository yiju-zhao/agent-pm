import { createCenterClient } from './client.ts';
import { loadPaseoCollectorConfig } from './config.ts';
import { PaseoCollector } from './loop.ts';
import { Outbox } from './outbox.ts';
import { createPaseoSdk } from './sdk.ts';
import { StateDir } from './state-store.ts';

/**
 * `herdr-pm collect-paseo --config <path>`: runs one Paseo collector until SIGINT/SIGTERM (or `signal`), then stops
 * reading, lets the content step in progress land in the outbox, closes the daemon connection and releases the state
 * directory. Agents are never touched.
 */
export async function runPaseoCollect(configPath: string, io: { stdout(t: string): void; stderr(t: string): void; signal?: AbortSignal }): Promise<number> {
  const { config, token, password } = loadPaseoCollectorConfig(configPath);
  const state = StateDir.open(config.stateDir, { sourceId: config.sourceId, serverId: config.paseo.serverId, server: config.server });
  let collector: PaseoCollector | null = null;
  try {
    const sdk = await createPaseoSdk({ url: config.paseo.url, password });
    collector = new PaseoCollector(config, {
      sdk,
      client: createCenterClient({ server: config.server, token }),
      state,
      outbox: new Outbox(config.stateDir),
      now: () => new Date(),
      log: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`herdr-pm collect-paseo: source ${config.sourceId} (daemon ${config.paseo.serverId} on ${config.machine}) -> ${config.server}\n`);
    await collector.start();
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
      io.signal?.addEventListener('abort', done, { once: true });
    });
    io.stdout('herdr-pm collect-paseo: stopping\n');
    return 0;
  } finally {
    if (collector) await collector.stop();
    else state.release();
  }
}
