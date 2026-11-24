/**
 * Copies text to the clipboard. Uses the async Clipboard API when available and
 * falls back to a hidden textarea + execCommand for older or non-secure contexts.
 * Resolves to false instead of throwing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the fallback.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
