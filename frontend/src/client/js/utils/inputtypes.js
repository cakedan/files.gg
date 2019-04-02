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

export function number(value, defaultValue) {
  value = parseInt(value);
  if (!Number.isNaN(value)) {
    return value;
  }
  return defaultValue;
}

export function func(value, defaultValue) {
  if (typeof(value) === 'function') {
    return value;
  }
  return defaultValue;
}

export function choices(choices, value, defaultValue) {
  if (choices.includes(value)) {
    return value;
  }
  return defaultValue;
}
