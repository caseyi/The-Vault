// Folder roles (docs/folder-roles.md): labels, small helpers and API calls
// shared by the Folder Roles panel, Health suspects, card detail breadcrumb and
// the Review tab. Same-origin JSON POSTs go through apiSend like everything else.

import { apiGet, apiSend, ApiError } from './api';

export const ROLE_OPTIONS = [
  { value: '', label: 'Auto' },
  { value: 'creator', label: 'Creator' },
  { value: 'passthrough', label: 'Container' },
  { value: 'category', label: 'Category' },
  { value: 'model', label: 'Model' },
  { value: 'ignore', label: 'Ignore' },
];

export const ROLE_HELP = {
  '': 'Let the scanner decide',
  creator: 'This folder is a creator',
  passthrough: 'Go inside; drop its name',
  category: 'A grouping folder: never a card; its name becomes genre, group or tags',
  model: 'Exactly one card: everything below belongs to it',
  ignore: 'Skip this folder and everything under it',
};

/** "category" -> "Category"; null / '' -> "Auto"; "container" is the file alias of passthrough. */
export function roleLabel(role) {
  const v = role === 'container' ? 'passthrough' : (role || '');
  const o = ROLE_OPTIONS.find(r => r.value === v);
  return o ? o.label : String(role);
}

/** Normalise a role value for a <select> ('' for none). */
export const roleValue = (role) => (role === 'container' ? 'passthrough' : (role || ''));

/** "a | b, c" -> ['a', 'b', 'c'] */
export function splitTags(s) {
  if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean);
  return String(s || '').split(/[|,]/).map(x => x.trim()).filter(Boolean);
}

/** Last path segment. */
export function baseName(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/**
 * POST /api/folder-roles. role '' or null clears the app mark.
 * Falls back to the older /api/organize/folder-overrides on a backend without the new route.
 */
export async function saveFolderRole({ path, role, genre, group, tags, note }) {
  const body = { path, role: role || null };
  if (role === 'category') {
    if (genre !== undefined) body.genre = genre || '';
    if (group !== undefined) body.group = group || '';
    if (tags !== undefined) body.tags = splitTags(tags);
  }
  if (note !== undefined) body.note = note;
  try {
    return await apiSend('/api/folder-roles', 'POST', body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && !(e.body && typeof e.body === 'object' && e.body.error)) {
      await apiSend('/api/organize/folder-overrides', 'POST', { path, role: role || '' });
      return { ok: true, rescan: true };
    }
    throw e;
  }
}

export const getFolderRoles = () => apiGet('/api/folder-roles');
export const getSuspects = (dismissed = false) => apiGet(`/api/folder-roles/suspects?dismissed=${dismissed ? 1 : 0}`);
export const dismissSuspect = (path, undo = false) =>
  apiSend('/api/folder-roles/suspects/dismiss', 'POST', undo ? { path, undo: true } : { path });

/**
 * Start a library scan the same way the Scan dialog does (POST /api/scan with the
 * default library path). Resolves to 'started' or 'running' (a scan was already going).
 * Progress shows in the sidebar scan indicator and the Scan dialog.
 */
export async function startRescan() {
  try {
    await apiSend('/api/scan', 'POST', {});
    return 'started';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return 'running';
    throw e;
  }
}

/** Toast text for a saved mark. */
export function savedMessage(name, role, res) {
  const what = role ? `${name} marked as ${roleLabel(role)}` : `${name} set back to Auto`;
  if (res && res.fileOverrides) return `${what} in the app, but _Meta/folder_roles.csv also marks it and the file wins.`;
  return `${what}. It applies on the next scan.`;
}

/** Folder shown on a role suggestion: rel, else the last two path segments. */
export function suggestionFolder(item) {
  if (item && item.rel) return item.rel;
  const parts = String((item && item.path) || '').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || ((item && item.model && item.model.name) || '');
}

/** "Mark Misc/Terrain as Category" */
export function roleSuggestionText(item) {
  return `Mark ${suggestionFolder(item)} as ${roleLabel(item && item.proposed)}`;
}
