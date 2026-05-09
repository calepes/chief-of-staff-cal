import { describe, it, expect, vi } from 'vitest';
import { ConversationState } from './state.js';
import type { ConversationMessage } from './state.js';

const makeFakeKv = () => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown, _ttlSec?: number) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); })
  };
};

const makeMsg = (role: 'user' | 'assistant', i: number): ConversationMessage => ({
  role,
  content: `msg ${i}`,
});

describe('ConversationState', () => {
  it('round-trips messages per chat', async () => {
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any);
    await state.append(123, { role: 'user', content: 'hola' });
    expect(await state.load(123)).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('passes TTL 43200s to kv.set', async () => {
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any);
    await state.append(1, { role: 'user', content: 'x' });
    expect(kv.set).toHaveBeenCalledWith('cos-ctx:1', expect.any(Array), 43200);
  });

  it('does not compact below 40 messages', async () => {
    const compact = vi.fn();
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any, compact);
    for (let i = 0; i < 39; i++) {
      await state.append(1, makeMsg('user', i));
    }
    expect(compact).not.toHaveBeenCalled();
    expect((await state.load(1))).toHaveLength(39);
  });

  it('triggers compaction at 40 messages and stores [summary, rest, newMsg]', async () => {
    const compact = vi.fn(async () => 'resumen compactado');
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any, compact);
    for (let i = 0; i < 40; i++) {
      await state.append(1, makeMsg('user', i));
    }
    await state.append(1, { role: 'assistant', content: 'nuevo' });
    expect(compact).toHaveBeenCalledOnce();
    const calls = compact.mock.calls as unknown[][];
    const compactArg = (calls[0]?.[0] as ConversationMessage[]) ?? [];
    expect(compactArg).toHaveLength(20);
    expect(compactArg[0]!.content).toBe('msg 0');
    expect(compactArg[19]!.content).toBe('msg 19');
    const stored = await state.load(1);
    expect(stored[0]).toEqual({ role: 'summary', content: 'resumen compactado' });
    expect(stored[stored.length - 1]).toEqual({ role: 'assistant', content: 'nuevo' });
    expect(stored).toHaveLength(22);
  });

  it('fallback truncation when compactor throws', async () => {
    const compact = vi.fn(async () => { throw new Error('haiku down'); });
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any, compact);
    for (let i = 0; i < 40; i++) {
      await state.append(1, makeMsg('user', i));
    }
    await state.append(1, { role: 'assistant', content: 'nuevo' });
    const stored = await state.load(1);
    expect(stored.every(m => m.role !== 'summary')).toBe(true);
    expect(stored).toHaveLength(21);
    expect(stored[stored.length - 1].content).toBe('nuevo');
  });

  it('strips existing summary before re-compacting', async () => {
    const compact = vi.fn(async () => 'summary');
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any, compact);
    const initial: ConversationMessage[] = [
      { role: 'summary', content: 'old summary' },
      ...Array.from({ length: 39 }, (_, i) => makeMsg('user', i)),
    ];
    kv.store.set('cos-ctx:1', initial);
    await state.append(1, { role: 'assistant', content: 'nuevo' });
    expect(compact).toHaveBeenCalledOnce();
    const stored = await state.load(1);
    expect(stored[0].role).toBe('summary');
    expect(stored[0].content).toBe('summary');
  });

  it('clear removes state', async () => {
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any);
    await state.append(1, { role: 'user', content: 'x' });
    await state.clear(1);
    expect(await state.load(1)).toEqual([]);
  });

  it('load returns empty array when key missing', async () => {
    const kv = makeFakeKv();
    const state = new ConversationState(kv as any);
    expect(await state.load(99)).toEqual([]);
  });
});
