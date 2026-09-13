import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelBridge } from '../services/panelBridge.js';

function makeTempBridge() {
  const bridgePath = fs.mkdtempSync(path.join(os.tmpdir(), 'panelbridge-queue-floor-'));
  fs.mkdirSync(path.join(bridgePath, 'outbox'), { recursive: true });
  return bridgePath;
}

describe('PanelBridge Node queue state corruption recovery', () => {
  let bridgePath;

  afterEach(() => {
    if (bridgePath) fs.rmSync(bridgePath, { recursive: true, force: true });
  });

  it('raises the next-result floor above surviving outbox files after a reset state', () => {
    bridgePath = makeTempBridge();
    fs.writeFileSync(
      path.join(bridgePath, 'outbox', 'res-0000000042.json.txt'),
      JSON.stringify({ seq: 42, result: { id: 'pending', success: true } }),
    );
    fs.writeFileSync(
      path.join(bridgePath, '.queue-state-node.json'),
      JSON.stringify({ nextCommandSeq: 1, lastConsumedResultSeq: 10 }),
    );

    const bridge = new PanelBridge();
    bridge.configure(bridgePath, true);
    bridge.ensureQueueProtocol();

    expect(bridge.queueState.nextResultSeq).toBe(43);
    const persisted = JSON.parse(fs.readFileSync(path.join(bridgePath, '.queue-state-node.json'), 'utf8'));
    expect(persisted.nextResultSeq).toBe(43);
  });

  it('uses Lua state as a floor when the outbox has already been cleaned', () => {
    bridgePath = makeTempBridge();
    fs.writeFileSync(
      path.join(bridgePath, 'queue-state-lua.json.txt'),
      JSON.stringify({ nextResultSeq: 88, lastCommandSeq: 3 }),
    );

    const bridge = new PanelBridge();
    bridge.configure(bridgePath, true);
    bridge.ensureQueueProtocol();

    expect(bridge.queueState.nextResultSeq).toBe(88);
  });
});
