import { MODE_IDS, type ModeId, type Settings } from '../shared/types';
import { validateModes } from './config';

export interface HotkeyRegistry {
  register(key: string, callback: () => void): boolean;
  unregister(key: string): void;
}

export class HotkeyManager {
  private active = new Map<ModeId, string>();
  private readonly owned = new Set<string>();
  private disposed = false;

  constructor(private readonly registry: HotkeyRegistry, private readonly callback: (mode: ModeId) => void) {}

  /** Validates first, replaces only changed bindings, and restores old bindings on conflict. */
  apply(modes: Settings['modes']): void {
    if (this.disposed) throw new Error('Hotkey manager is disposed.');
    const validated = validateModes(modes);
    const desired = new Map(MODE_IDS.map(mode => [mode, validated[mode].shortcut]));
    const changed = MODE_IDS.filter(mode => this.active.get(mode) !== desired.get(mode));
    if (!changed.length) return;
    const removed: [ModeId, string][] = [];
    const added: string[] = [];
    try {
      // Release changed old keys first so two modes can exchange their shortcuts.
      for (const mode of changed) {
        const old = this.active.get(mode);
        if (!old) continue;
        this.registry.unregister(old);
        this.owned.delete(old);
        removed.push([mode, old]);
      }
      for (const mode of changed) {
        const key = desired.get(mode)!;
        this.register(key, mode);
        added.push(key);
      }
      this.active = desired;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const key of added.reverse()) {
        try { this.registry.unregister(key); this.owned.delete(key); }
        catch (cleanupError) { rollbackErrors.push(cleanupError); }
      }
      for (const [mode, key] of removed) {
        try { this.register(key, mode); }
        catch (restoreError) { this.active.delete(mode); rollbackErrors.push(restoreError); }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'Hotkey update failed and some previous shortcuts could not be restored.');
      }
      throw error;
    }
  }

  /** Unregister only this manager's bindings, never the application's global registry. */
  dispose(): void {
    this.disposed = true;
    this.active.clear();
    const errors: unknown[] = [];
    for (const key of this.owned) {
      try { this.registry.unregister(key); this.owned.delete(key); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Some hotkeys could not be unregistered.');
  }

  private register(key: string, mode: ModeId): void {
    const registered = this.registry.register(key, () => {
      if (!this.disposed && this.active.get(mode) === key) this.callback(mode);
    });
    if (!registered) throw new Error(`Cannot register shortcut ${key}; it may already be in use.`);
    this.owned.add(key);
  }
}
