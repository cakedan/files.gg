import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';

interface SortableGridProps<T extends { id: string }> {
  items: T[];
  /** Name used in the handle label and screen-reader announcements. */
  nameOf: (item: T) => string;
  onReorder: (ids: string[]) => void;
  renderItem: (item: T, handle: ReactNode) => ReactNode;
  disabled?: boolean;
}

const instructions: ScreenReaderInstructions = {
  draggable: 'To reorder, press space or enter to pick the file up, use the arrow keys to move it, then space or enter to drop it, or escape to cancel.',
};

/** A dnd-kit sortable grid. Pointer drags start after 6 px; the keyboard sensor reorders with the arrow keys. */
export function SortableGrid<T extends { id: string }>({ items, nameOf, onReorder, renderItem, disabled = false }: SortableGridProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map((item) => item.id);
  const name = (id: string | number) => {
    const item = items.find((each) => each.id === id);
    return item ? nameOf(item) : 'file';
  };
  const position = (id: string | number) => ids.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, position ${position(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} moved to position ${position(over.id)} of ${ids.length}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${name(active.id)} dropped at position ${position(over.id)} of ${ids.length}.` : `${name(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: instructions }}>
      <SortableContext items={ids} strategy={rectSortingStrategy} disabled={disabled}>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <SortableTile key={item.id} id={item.id} label={`Move ${nameOf(item)}`} disabled={disabled}>
              {(handle) => renderItem(item, handle)}
            </SortableTile>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableTile({ id, label, disabled, children }: { id: string; label: string; disabled: boolean; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const handle = disabled ? null : (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label={label}
      title="Drag to reorder"
      {...attributes}
      {...listeners}
      className="inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text active:cursor-grabbing"
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`relative ${isDragging ? 'z-10 opacity-80 shadow-card' : ''}`}
      data-testid="album-item"
    >
      {children(handle)}
    </li>
  );
}
