/**
 * The Files page's state in the URL search params (contract §8: page, sort, query
 * and filters live in the URL). Defaults are left out, so a clean URL is the default view.
 */

import { FILE_SORTS, FILE_TYPE_FILTERS, type FileSort, type FileTypeFilter, type MyFilesParams, type Visibility } from '../api';

export const PAGE_SIZE = 25;
const VISIBILITIES: readonly Visibility[] = ['link', 'password', 'private'];

export type FilesView = 'table' | 'grid';

export interface FilesUrlState {
  query: string;
  sort: FileSort;
  type: FileTypeFilter | null;
  access: Visibility | null;
  temporary: boolean;
  /** 1-based. */
  page: number;
  view: FilesView;
}

export const DEFAULT_FILES_STATE: FilesUrlState = {
  query: '',
  sort: '-created',
  type: null,
  access: null,
  temporary: false,
  page: 1,
  view: 'table',
};

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? (value as T) : null;

export function parseFilesState(params: URLSearchParams): FilesUrlState {
  const page = Number(params.get('page'));
  return {
    query: params.get('q')?.trim() ?? '',
    sort: oneOf(FILE_SORTS, params.get('sort')) ?? DEFAULT_FILES_STATE.sort,
    type: oneOf(FILE_TYPE_FILTERS, params.get('type')),
    access: oneOf(VISIBILITIES, params.get('access')),
    temporary: params.get('temporary') === '1',
    page: Number.isInteger(page) && page > 1 ? page : 1,
    view: params.get('view') === 'grid' ? 'grid' : 'table',
  };
}

export function filesSearchParams(state: FilesUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.sort !== DEFAULT_FILES_STATE.sort) params.set('sort', state.sort);
  if (state.type) params.set('type', state.type);
  if (state.access) params.set('access', state.access);
  if (state.temporary) params.set('temporary', '1');
  if (state.page > 1) params.set('page', String(state.page));
  if (state.view !== 'table') params.set('view', state.view);
  return params;
}

/**
 * Applies a change. Anything but the page or the view changes the result set, so
 * it goes back to page 1.
 */
export function patchFilesState(state: FilesUrlState, patch: Partial<FilesUrlState>): FilesUrlState {
  const next = { ...state, ...patch };
  const resets = (Object.keys(patch) as Array<keyof FilesUrlState>).some((key) => key !== 'page' && key !== 'view' && patch[key] !== state[key]);
  if (resets && patch.page === undefined) next.page = 1;
  return next;
}

export function toApiParams(state: FilesUrlState): MyFilesParams {
  return {
    ...(state.query ? { query: state.query } : {}),
    sort_by: state.sort,
    ...(state.type ? { type: state.type } : {}),
    ...(state.access ? { visibility: state.access } : {}),
    ...(state.temporary ? { temporary: true } : {}),
    offset: (state.page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
  };
}

export const pageCount = (count: number) => Math.max(1, Math.ceil(count / PAGE_SIZE));
