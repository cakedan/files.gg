import type { FileData } from '../types';

export type Visibility = NonNullable<FileData['visibility']>;

/**
 * Who can open a file or album, said plainly wherever it's viewed (PRODUCT.md, principle 3).
 * A private one only reaches the viewer through its owner's pass, so "you" is the owner.
 */
export const ACCESS_LABELS: Record<Visibility, string> = {
  link: 'Anyone with the link',
  password: 'Password protected',
  private: 'Only you can open this',
};

/** Under Copy link on password files: the link alone isn't enough. */
export const PASSWORD_SHARE_NOTE = 'Anyone you share it with needs the password too.';
