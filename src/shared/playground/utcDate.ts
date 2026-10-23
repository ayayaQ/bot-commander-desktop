/** Trusted QuickJS bootstrap fragment. Local dates use UTC, never host timezone/locale. */
export const UTC_DATE_SETUP = String.raw`
  const nativeParse = NativeDate.parse, nativeUTC = NativeDate.UTC;
  const iso = NativeDate.prototype.toISOString, utcString = NativeDate.prototype.toUTCString;
  const parseUTC = value => {
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return nativeParse(text);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(text))
      return nativeParse(text + 'Z');
    if (/([zZ]|[+-]\d{2}:?\d{2}|GMT|UTC)$/.test(text)) return nativeParse(text);
    return NaN;
  };
  for (const suffix of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    NativeDate.prototype['get' + suffix] = NativeDate.prototype['getUTC' + suffix];
    if (NativeDate.prototype['setUTC' + suffix])
      NativeDate.prototype['set' + suffix] = NativeDate.prototype['setUTC' + suffix];
  }
  NativeDate.prototype.getTimezoneOffset = function() { return Number.isNaN(this.getTime()) ? NaN : 0; };
  NativeDate.prototype.getYear = function() { return this.getUTCFullYear() - 1900; };
  NativeDate.prototype.setYear = function(value) {
    value = Number(value);
    return this.setUTCFullYear(value >= 0 && value <= 99 ? value + 1900 : value);
  };
  const full = function() { return Number.isNaN(this.getTime()) ? 'Invalid Date' : iso.call(this); };
  NativeDate.prototype.toString = function() { return utcString.call(this); };
  NativeDate.prototype.toLocaleString = full;
  NativeDate.prototype.toDateString = NativeDate.prototype.toLocaleDateString = function() {
    return Number.isNaN(this.getTime()) ? 'Invalid Date' : iso.call(this).slice(0, 10);
  };
  NativeDate.prototype.toTimeString = NativeDate.prototype.toLocaleTimeString = function() {
    return Number.isNaN(this.getTime()) ? 'Invalid Date' : iso.call(this).slice(11);
  };
`
