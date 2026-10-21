import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/defaults';
import { MODE_IDS } from '../shared/types';
import { HotkeyManager } from '../electron/hotkeys';

function setup() {
  const keys = new Map<string, () => void>();
  const blocked = new Set<string>();
  const registry = {
    register: vi.fn((key: string, callback: () => void) => {
      if (blocked.has(key) || keys.has(key)) return false;
      keys.set(key, callback);
      return true;
    }),
    unregister: vi.fn((key: string) => { keys.delete(key); }),
  };
  const callback = vi.fn();
  const manager = new HotkeyManager(registry, callback);
  return { keys, blocked, registry, callback, manager };
}

describe('HotkeyManager', () => {
  it('does not register in the constructor, then registers all modes with the right callbacks', () => {
    const h = setup();
    expect(h.registry.register).not.toHaveBeenCalled();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    for (const mode of MODE_IDS) h.keys.get(modes[mode].shortcut)!();
    expect(h.callback.mock.calls.map(call => call[0])).toEqual([...MODE_IDS]);
  });

  it('does not touch unchanged or canonically equivalent bindings', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    h.registry.register.mockClear();
    h.registry.unregister.mockClear();
    modes.chat.shortcut = 'shift+ctrl+spacebar';
    modes.chat.prompt = 'unrelated preference change';
    h.manager.apply(modes);
    expect(h.registry.register).not.toHaveBeenCalled();
    expect(h.registry.unregister).not.toHaveBeenCalled();
  });

  it('replaces only changed bindings and disables stale callbacks', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    const old = h.keys.get(modes.chat.shortcut)!;
    const previous = modes.chat.shortcut;
    modes.chat.shortcut = 'Control+Alt+A';
    h.registry.register.mockClear();
    h.registry.unregister.mockClear();
    h.manager.apply(modes);
    expect(h.registry.unregister.mock.calls).toEqual([[previous]]);
    expect(h.registry.register.mock.calls.map(call => call[0])).toEqual(['Control+Alt+A']);
    old();
    expect(h.callback).not.toHaveBeenCalled();
    h.keys.get('Control+Alt+A')!();
    expect(h.callback).toHaveBeenCalledWith('chat');
  });

  it('supports exchanging two already-owned shortcuts', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    [modes.chat.shortcut, modes.screen.shortcut] = [modes.screen.shortcut, modes.chat.shortcut];
    h.manager.apply(modes);
    h.keys.get(modes.chat.shortcut)!();
    h.keys.get(modes.screen.shortcut)!();
    expect(h.callback.mock.calls.map(call => call[0])).toEqual(['chat', 'screen']);
    expect(h.keys.size).toBe(4);
  });

  it.each(['duplicate', 'reserved', 'outputs'])('rejects invalid %s modes before touching registrations', invalid => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    if (invalid === 'duplicate') modes.files.shortcut = 'ctrl+shift+space';
    if (invalid === 'reserved') modes.chat.shortcut = 'Ctrl+N';
    if (invalid === 'outputs') modes.chat.outputs = { chat: false, clipboard: false, speech: false };
    h.registry.register.mockClear();
    h.registry.unregister.mockClear();
    expect(() => h.manager.apply(modes)).toThrow();
    expect(h.registry.register).not.toHaveBeenCalled();
    expect(h.registry.unregister).not.toHaveBeenCalled();
    expect(h.keys.size).toBe(4);
  });

  it('cleans successful new registrations before restoring old ones after a conflict', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    const before = [...h.keys.keys()];
    const updated = structuredClone(modes);
    updated.chat.shortcut = 'Control+Alt+A';
    updated.screen.shortcut = 'Control+Alt+B';
    h.blocked.add(updated.screen.shortcut);
    expect(() => h.manager.apply(updated)).toThrow('already be in use');
    expect([...h.keys.keys()].sort()).toEqual(before.sort());
    expect(h.registry.unregister).toHaveBeenCalledWith(updated.chat.shortcut);
    expect(h.registry.unregister).not.toHaveBeenCalledWith(updated.screen.shortcut);
    h.keys.get(modes.chat.shortcut)!();
    expect(h.callback).toHaveBeenCalledWith('chat');
    h.blocked.clear();
    h.manager.apply(updated);
    expect(h.keys.has(updated.chat.shortcut)).toBe(true);
  });

  it('does not unregister a conflicting key owned by another component', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    const foreign = vi.fn();
    h.keys.set(modes.screen.shortcut, foreign);
    expect(() => h.manager.apply(modes)).toThrow('Cannot register');
    expect([...h.keys.keys()]).toEqual([modes.screen.shortcut]);
    h.manager.dispose();
    expect(h.keys.get(modes.screen.shortcut)).toBe(foreign);
  });

  it('restores old registrations if the registry throws instead of returning false', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    const old = modes.chat.shortcut;
    modes.chat.shortcut = 'Control+Alt+A';
    h.registry.register.mockImplementationOnce(() => { throw new Error('native registration failed'); });
    expect(() => h.manager.apply(modes)).toThrow('native registration failed');
    expect(h.keys.has(old)).toBe(true);
    expect(h.keys.has(modes.chat.shortcut)).toBe(false);
  });

  it('reports restoration failures instead of pretending rollback succeeded', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    const old = modes.chat.shortcut;
    modes.chat.shortcut = 'Control+Alt+A';
    h.blocked.add(old);
    h.blocked.add(modes.chat.shortcut);
    expect(() => h.manager.apply(modes)).toThrow(AggregateError);
    h.blocked.clear();
    h.manager.apply(modes);
    expect(h.keys.size).toBe(4);
  });

  it('disposes only owned shortcuts, is repeatable and suppresses captured callbacks', () => {
    const h = setup();
    const modes = defaultSettings().modes;
    h.manager.apply(modes);
    const captured = [...h.keys.values()];
    h.keys.set('Control+Alt+Z', () => {});
    h.manager.dispose();
    for (const callback of captured) callback();
    expect(h.callback).not.toHaveBeenCalled();
    expect([...h.keys.keys()]).toEqual(['Control+Alt+Z']);
    h.registry.unregister.mockClear();
    h.manager.dispose();
    expect(h.registry.unregister).not.toHaveBeenCalled();
    expect(() => h.manager.apply(modes)).toThrow('disposed');
  });

  it('attempts all disposal removals and lets a subsequent dispose retry failures', () => {
    const h = setup();
    h.manager.apply(defaultSettings().modes);
    h.registry.unregister.mockImplementationOnce(() => { throw new Error('temporary unregister failure'); });
    expect(() => h.manager.dispose()).toThrow(AggregateError);
    expect(h.keys.size).toBe(1);
    h.manager.dispose();
    expect(h.keys.size).toBe(0);
  });
});
