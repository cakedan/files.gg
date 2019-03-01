export function rshift(number, bits) {
  return number / Math.pow(2, bits);
};

export function lshift(number, bits) {
  return number * Math.pow(2, bits);
};

export function snowflakeToTimestamp(snowflake) {
  return Math.floor(rshift(snowflake, 22)) + 1550102400000;
};


const fileSizes = ['B', 'Kb', 'Mb', 'Gb', 'Tb'];
export function formatBytes(bytes, decimals) {
  decimals = decimals || 0;
  const divideBy = 1024;
  const amount = Math.floor(Math.log(bytes) / Math.log(divideBy));
  const type = fileSizes[amount];
  const fixed = parseFloat(bytes / Math.pow(divideBy, amount)).toFixed(decimals).split('.');
  return [parseInt(fixed.shift()).toLocaleString(), fixed.shift()].filter((v) => v).join('.') + ' ' + type;
};

export function formatTime(ms, options) {
  options = Object.assign({}, options);
  options.day = (options.day === undefined) ? true : !!options.day;
  options.hour = (options.hour === undefined) ? true : !!options.hour;
  options.ms = options.ms || false;

  let days, hours, minutes, seconds, milliseconds;
  seconds = Math.floor(ms / 1000);
  minutes = Math.floor(seconds / 60);
  seconds = seconds % 60;
  hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  days = Math.floor(hours / 24);
  hours = hours % 24;
  milliseconds = Math.floor(ms % 1000);


  days = (days) ? `${days}d` : null;
  hours = ((options.day && days) ? `0${hours}` : `${hours}`).slice(-2);
  minutes = ((options.hour) ? `0${minutes}` : `${minutes}`).slice(-2);
  seconds = (`0${seconds}`).slice(-2);
  milliseconds = (`00${milliseconds}`).slice(-3);

  let time = `${minutes}:${seconds}`;
  if (options.hour) {
    time = `${hours}:${time}`;
  }
  if (options.ms) {
    time = `${time}.${milliseconds}`;
  }
  if (options.day && days) {
    time = `${days} ${time}`;
  }

  return time;
};
