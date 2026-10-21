import type { OverlayAPI } from '../shared/types';

declare global {
  interface Window {
    overlay?: OverlayAPI;
  }
}

export {};
