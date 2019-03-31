export function boolean(value, defaultValue) {
  value = String(value).toLowerCase();
  if (['true', '1', 'yes', 'ok', 'okay'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no'].includes(value)) {
    return false;
  }
  return !!defaultValue;
}
