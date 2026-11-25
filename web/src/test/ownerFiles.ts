import type { MyFilesResponse, OwnerAlbum, OwnerAlbumItem, OwnerFile } from '../lib/api';

let n = 0;

/** A minimal owner file (contract §6) for tests. */
export function ownerFile(overrides: Partial<OwnerFile> = {}): OwnerFile {
  n++;
  const id = overrides.id ?? String(1_000_000 + n);
  const name = overrides.name ?? `file-${id}`;
  const extension = overrides.extension ?? 'png';
  return {
    id,
    vanity: `v${id}`,
    mimetype: 'image/png',
    extension,
    name,
    filename: `${name}.${extension}`,
    size: 1024,
    width: 800,
    height: 600,
    duration: null,
    views: 0,
    kind: 'image',
    cdn_url: `https://cdn.files.gg/files/v${id}.${extension}`,
    url: `https://files.gg/v${id}.${extension}`,
    uploaded_at: Math.floor(Date.now() / 1000) - 3600,
    expires_at: null,
    visibility: 'link',
    media: {},
    processing: false,
    assets: {},
    access_version: 0,
    unlock_ttl: 3600,
    password_expires_at: null,
    show_name_when_locked: false,
    albums: [],
    ...overrides,
  };
}

export function filesResponse(items: OwnerFile[], total = items.length): MyFilesResponse {
  const size = items.reduce((sum, file) => sum + file.size, 0);
  return { count: items.length, items, size, total: { count: total, size } };
}

export function ownerAlbum(items: OwnerFile[], overrides: Partial<OwnerAlbum> = {}): OwnerAlbum {
  return {
    id: '900',
    vanity: 'alb900',
    url: 'https://files.gg/a/alb900',
    title: 'Trip',
    description: '',
    layout: 'auto',
    visibility: 'link',
    cover: null,
    collage: null,
    created_at: 1_795_000_000,
    updated_at: 1_795_000_000,
    access_version: 0,
    unlock_ttl: 3600,
    password_expires_at: null,
    show_name_when_locked: false,
    cover_file_id: null,
    items: items.map((file, position): OwnerAlbumItem => ({ ...file, position, caption: '', shown: file.visibility === 'link' })),
    ...overrides,
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
