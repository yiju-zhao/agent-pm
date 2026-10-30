// The page is opened over plain http (Tailscale), where browsers hide navigator.clipboard. So: the clipboard API when
// the browser offers it, a hidden textarea and execCommand('copy') when it does not (or when it refuses).

/** Selects `text` in an off-screen textarea and runs the old copy command. Everything is undone afterwards. */
function copyWithTextarea(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  // readOnly keeps phones from opening the keyboard; the rest keeps it out of sight and out of the page's layout.
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0', pointerEvents: 'none' });
  document.body.append(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
}

/**
 * Puts `text` on the clipboard; `false` when the browser would not (the caller then shows the text so it can be
 * selected by hand). Without a secure context the fallback runs before any `await`, i.e. still inside the click.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or no focus: try the other way.
    }
  }
  return copyWithTextarea(text);
}
