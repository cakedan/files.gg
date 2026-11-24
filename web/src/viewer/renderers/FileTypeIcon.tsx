import type { LucideProps } from 'lucide-react';
import { createElement } from 'react';

import type { FileKind } from '../types';
import { fileIcon } from './fileIcon';

interface FileTypeIconProps extends LucideProps {
  kind: FileKind;
  mimetype: string;
}

export function FileTypeIcon({ kind, mimetype, ...props }: FileTypeIconProps) {
  return createElement(fileIcon(kind, mimetype), { 'aria-hidden': true, ...props });
}
