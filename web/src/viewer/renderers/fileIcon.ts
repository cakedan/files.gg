import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';

import type { FileKind } from '../types';

const ARCHIVE = /(zip|x-7z|x-rar|x-tar|gzip|x-bzip|x-xz|zstd|x-compress)/;
const CODE = /(json|javascript|typescript|xml|x-sh|x-python|x-httpd-php|x-c|x-java|x-rust|x-go|yaml|toml)/;
const SHEET = /(spreadsheet|excel|csv)/;

/** Picks a type icon from the kind, then the mimetype. */
export function fileIcon(kind: FileKind, mimetype: string): LucideIcon {
  switch (kind) {
    case 'image':
      return FileImage;
    case 'video':
      return FileVideo;
    case 'audio':
      return FileAudio;
    case 'pdf':
      return FileText;
    case 'text':
      return CODE.test(mimetype) ? FileCode : FileText;
    case 'file':
      break;
  }
  if (ARCHIVE.test(mimetype)) return FileArchive;
  if (SHEET.test(mimetype)) return FileSpreadsheet;
  if (CODE.test(mimetype)) return FileCode;
  if (mimetype.startsWith('text/')) return FileText;
  if (mimetype.startsWith('image/')) return FileImage;
  if (mimetype.startsWith('video/')) return FileVideo;
  if (mimetype.startsWith('audio/')) return FileAudio;
  return File;
}
