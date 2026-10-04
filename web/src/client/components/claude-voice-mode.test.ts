// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ClaudeVoiceMode } from './claude-voice-mode.js';
import './claude-voice-mode.js';

describe('claude-voice-mode', () => {
  it('stays on at the end of a drag that started on End; a still tap ends it', async () => {
    // Not begun: no microphone, just the sheet and its buttons.
    const sheet = document.createElement('claude-voice-mode') as ClaudeVoiceMode;
    document.body.appendChild(sheet);
    await sheet.updateComplete;
    const end = sheet.shadowRoot?.querySelector('button.danger') as HTMLButtonElement;
    // iOS ends a drag that began on a button with a pointerup on it, not a pointercancel.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 200,
        clientY: y,
        bubbles: true,
        composed: true,
      });
      end.dispatchEvent(new PointerEvent('pointerdown', at(700)));
      end.dispatchEvent(new PointerEvent('pointerup', at(700 + dy)));
    };
    touch(-100);
    expect(sheet.isConnected).toBe(true);
    touch(2);
    expect(sheet.isConnected).toBe(false);
    document.body.click(); // the click that follows the tap, swallowed
  });
});
