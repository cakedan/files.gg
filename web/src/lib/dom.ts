/** True for inputs, textareas, selects and contenteditable elements (and their contents). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}
