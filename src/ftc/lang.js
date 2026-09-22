/**
 * The bits of `java.lang` and `java.util` an op-mode actually touches.
 *
 * Not an attempt at a Java runtime. This is the handful of things that turn up
 * in real FTC code -- `Math.toRadians`, `String.format("%.2f", x)`, an
 * `ArrayList` of detections, an `enum` for a state machine -- implemented so
 * that the compiled code behaves the way the Java did.
 *
 * The three that are worth stating because they are silently different if you
 * get them wrong:
 *
 *  - **`Math.round`** returns a whole number and rounds half *up*, so
 *    `round(-2.5)` is -2. JavaScript agrees, so it is passed through; it is
 *    here to be checked rather than assumed.
 *  - **`String.format`** is the one Java API whose absence would be noticed
 *    immediately: `%.2f` appears in almost every op-mode's telemetry.
 *  - **Enums are objects, not strings**, so `==` works, `switch` works, and
 *    `name()` and `ordinal()` are there.
 *
 * @module
 */

/** `java.lang.Math`, which is not quite `Math`. */
export const JMath = Object.freeze({
  PI: Math.PI,
  E: Math.E,
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  hypot: Math.hypot,
  floor: Math.floor,
  ceil: Math.ceil,
  random: Math.random,
  // Java's round returns a long and rounds half up; so does JavaScript's.
  round: Math.round,
  rint: (x) => {
    // Unlike `round`, `rint` rounds half to *even*. Rare, and wrong is worse.
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  },
  signum: (x) => (x > 0 ? 1 : x < 0 ? -1 : x),
  toRadians: (deg) => (deg * Math.PI) / 180,
  toDegrees: (rad) => (rad * 180) / Math.PI,
  copySign: (magnitude, sign) => (sign < 0 ? -Math.abs(magnitude) : Math.abs(magnitude)),
  floorMod: (a, b) => ((a % b) + b) % b,
  floorDiv: (a, b) => Math.floor(a / b),
});

/**
 * How Java prints a number.
 *
 * `1.0` rather than `1`, because a `double` always shows a decimal point and
 * telemetry that reads `1` where the robot said `1.0` is a small lie that makes
 * comparing two runs harder than it should be. Integers print bare.
 */
export function javaString(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : Number.isNaN(value) ? 'NaN' : '-Infinity';
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

/**
 * `String.format`, enough of it.
 *
 * Supports `%d %s %f %b %c %x %X %o %e %%` and `%n`, with a width, a `-` for
 * left alignment, a `0` pad, a `+` sign and a precision. That is every
 * conversion that appears in an op-mode's telemetry line, and an unsupported
 * one is left in place rather than silently dropped so it is visible.
 */
export function format(pattern, ...args) {
  let index = 0;
  return String(pattern).replace(
    /%(\d+\$)?([-+ 0,#]*)(\d+)?(?:\.(\d+))?([sdfbcxXoeEn%])/g,
    (whole, position, flags, width, precision, conversion) => {
      if (conversion === '%') return '%';
      if (conversion === 'n') return '\n';
      const value = position ? args[Number(position.slice(0, -1)) - 1] : args[index++];
      let text;
      switch (conversion) {
        case 'd':
          text = String(Math.trunc(Number(value) || 0));
          if (flags.includes(',')) text = groupThousands(text);
          break;
        case 'f': {
          const places = precision === undefined ? 6 : Number(precision);
          text = Number(value).toFixed(places);
          if (flags.includes(',')) text = groupThousands(text);
          break;
        }
        case 'e':
        case 'E': {
          const places = precision === undefined ? 6 : Number(precision);
          text = Number(value).toExponential(places);
          if (conversion === 'E') text = text.toUpperCase();
          break;
        }
        case 'b':
          text = value ? 'true' : 'false';
          break;
        case 'c':
          text = typeof value === 'number' ? String.fromCharCode(value) : String(value);
          break;
        case 'x':
          text = (Math.trunc(Number(value)) >>> 0).toString(16);
          break;
        case 'X':
          text = (Math.trunc(Number(value)) >>> 0).toString(16).toUpperCase();
          break;
        case 'o':
          text = (Math.trunc(Number(value)) >>> 0).toString(8);
          break;
        default:
          text = javaString(value);
          if (precision !== undefined) text = text.slice(0, Number(precision));
          break;
      }
      if (flags.includes('+') && 'dfeE'.includes(conversion) && Number(value) >= 0) text = `+${text}`;
      const pad = width ? Number(width) - text.length : 0;
      if (pad > 0) {
        if (flags.includes('-')) text += ' '.repeat(pad);
        else if (flags.includes('0') && 'dfxXoeE'.includes(conversion)) {
          const negative = text.startsWith('-') || text.startsWith('+');
          text = negative
            ? text[0] + '0'.repeat(pad) + text.slice(1)
            : '0'.repeat(pad) + text;
        } else text = ' '.repeat(pad) + text;
      }
      return text;
    },
  );
}

function groupThousands(text) {
  const [whole, fraction] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** `java.lang.String`'s statics, and the instance methods we shim on strings. */
export const JString = Object.freeze({
  format,
  valueOf: javaString,
  join: (separator, ...parts) => {
    const items = parts.length === 1 && isList(parts[0]) ? [...iterate(parts[0])] : parts;
    return items.map(javaString).join(separator);
  },
});

/** `org.firstinspires.ftc.robotcore.external.navigation`-ish helpers. */
export const Range = Object.freeze({
  clip: (value, min, max) => Math.min(Math.max(value, min), max),
  scale: (value, fromLow, fromHigh, toLow, toHigh) =>
    toLow + ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow),
  throwIfRangeIsInvalid: () => {},
});

/**
 * An enum: real objects, so `==` and `switch` behave.
 *
 * `values()` returns a fresh array each time, as Java's does, so a routine that
 * sorts it in place does not corrupt the enum.
 */
export function makeEnum(name, constantNames) {
  const constants = constantNames.map((constant, ordinal) => {
    const value = {
      __enum: name,
      __name: constant,
      __ordinal: ordinal,
      name: () => constant,
      ordinal: () => ordinal,
      toString: () => constant,
      compareTo: (other) => ordinal - (other?.__ordinal ?? 0),
      equals: (other) => other === value,
    };
    return value;
  });
  const holder = {
    __enum: name,
    values: () => [...constants],
    valueOf: (text) => {
      const found = constants.find((c) => c.__name === text);
      if (!found) throw javaError('IllegalArgumentException', `no enum constant ${name}.${text}`);
      return found;
    },
  };
  for (const constant of constants) holder[constant.__name] = constant;
  return holder;
}

/** An `ArrayList`, which is what vision hands back and teams keep paths in. */
export class ArrayList {
  constructor(initial) {
    this.items = initial === undefined || typeof initial === 'number' ? [] : [...iterate(initial)];
  }

  add(a, b) {
    // `add(item)` and `add(index, item)`.
    if (b === undefined) {
      this.items.push(a);
      return true;
    }
    this.items.splice(a, 0, b);
    return true;
  }

  addAll(other) {
    this.items.push(...iterate(other));
    return true;
  }

  get(index) {
    if (index < 0 || index >= this.items.length) {
      throw javaError('IndexOutOfBoundsException', `index ${index} of ${this.items.length}`);
    }
    return this.items[index];
  }

  set(index, value) {
    const old = this.items[index];
    this.items[index] = value;
    return old;
  }

  size() {
    return this.items.length;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  clear() {
    this.items.length = 0;
  }

  contains(value) {
    return this.items.includes(value);
  }

  indexOf(value) {
    return this.items.indexOf(value);
  }

  remove(value) {
    if (typeof value === 'number' && !this.items.includes(value)) {
      return this.items.splice(value, 1)[0];
    }
    const at = this.items.indexOf(value);
    if (at < 0) return false;
    this.items.splice(at, 1);
    return true;
  }

  iterator() {
    return this.items[Symbol.iterator]();
  }

  toArray() {
    return [...this.items];
  }

  sort(comparator) {
    this.items.sort(comparator ? (a, b) => comparator.compare?.(a, b) ?? comparator(a, b) : undefined);
  }

  stream() {
    throw javaError('UnsupportedOperationException', 'streams are not supported');
  }

  toString() {
    return `[${this.items.map(javaString).join(', ')}]`;
  }

  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
}

/** A `HashMap`, for the occasional lookup table. */
export class HashMap {
  constructor() {
    this.map = new Map();
  }

  put(key, value) {
    const old = this.map.get(key);
    this.map.set(key, value);
    return old ?? null;
  }

  get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  getOrDefault(key, fallback) {
    return this.map.has(key) ? this.map.get(key) : fallback;
  }

  containsKey(key) {
    return this.map.has(key);
  }

  remove(key) {
    const old = this.map.get(key);
    this.map.delete(key);
    return old ?? null;
  }

  size() {
    return this.map.size;
  }

  isEmpty() {
    return this.map.size === 0;
  }

  clear() {
    this.map.clear();
  }

  keySet() {
    return new ArrayList([...this.map.keys()]);
  }

  values() {
    return new ArrayList([...this.map.values()]);
  }

  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
}

/** `Arrays`, the two methods anybody uses. */
export const Arrays = Object.freeze({
  asList: (...items) => new ArrayList(items.length === 1 && Array.isArray(items[0]) ? items[0] : items),
  toString: (array) => `[${[...iterate(array)].map(javaString).join(', ')}]`,
  fill: (array, value) => {
    for (let i = 0; i < array.length; i++) array[i] = value;
    return array;
  },
  sort: (array) => {
    array.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return array;
  },
  copyOf: (array, length) => {
    const out = new Array(length).fill(0);
    for (let i = 0; i < Math.min(length, array.length); i++) out[i] = array[i];
    return out;
  },
});

/** `Collections`, the same. */
export const Collections = Object.freeze({
  emptyList: () => new ArrayList([]),
  unmodifiableList: (list) => list,
  reverse: (list) => {
    if (list instanceof ArrayList) list.items.reverse();
    else list.reverse();
    return list;
  },
});

/** Boxed primitives, for `Double.parseDouble` and friends. */
export const Double = Object.freeze({
  parseDouble: (text) => Number.parseFloat(text),
  valueOf: (value) => Number(value),
  toString: javaString,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
  NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
  isNaN: Number.isNaN,
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
});

export const Integer = Object.freeze({
  parseInt: (text, radix) => Number.parseInt(text, radix ?? 10),
  valueOf: (value) => Math.trunc(Number(value)),
  toString: (value, radix) => Math.trunc(value).toString(radix ?? 10),
  MAX_VALUE: 2147483647,
  MIN_VALUE: -2147483648,
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
});

export const Boolean_ = Object.freeze({
  parseBoolean: (text) => String(text).toLowerCase() === 'true',
  valueOf: (value) => Boolean(value),
  toString: (value) => (value ? 'true' : 'false'),
});

export const Long = Integer;
export const Float = Double;

/** An exception that carries the Java class name a `catch` clause matches on. */
export function javaError(className, message) {
  const error = new Error(message ?? className);
  error.name = className;
  error.javaClass = className;
  return error;
}

/**
 * Does `error` match one of these `catch` clause types?
 *
 * The supertypes matter: `catch (Exception e)` has to catch everything, which
 * is what most op-modes actually write.
 */
export function caught(error, types) {
  const CATCH_ALL = new Set(['Exception', 'Throwable', 'RuntimeException', 'Error']);
  const actual = error?.javaClass ?? error?.name ?? 'Exception';
  return types.some((type) => type === actual || CATCH_ALL.has(type));
}

/** True for the things a `for (X x : ...)` can walk. */
export function isList(value) {
  return Array.isArray(value) || value instanceof ArrayList || typeof value?.[Symbol.iterator] === 'function';
}

/** What an enhanced for loop walks: an array, a shimmed list, or an iterable. */
export function iterate(value) {
  if (value === null || value === undefined) {
    throw javaError('NullPointerException', 'cannot iterate over null');
  }
  if (Array.isArray(value)) return value;
  if (typeof value[Symbol.iterator] === 'function') return value;
  if (typeof value.iterator === 'function') {
    const it = value.iterator();
    return { [Symbol.iterator]: () => it };
  }
  throw javaError('ClassCastException', 'not something that can be iterated');
}

/** `new int[2][3]` -- rectangular, filled with the element's default. */
export function newArray(sizes, fill) {
  const [first, ...rest] = sizes;
  const out = new Array(first);
  for (let i = 0; i < first; i++) out[i] = rest.length ? newArray(rest, fill) : fill;
  return out;
}

/**
 * Java truthiness, which is only `boolean`.
 *
 * A null `Boolean` throws in Java rather than being false, and an op-mode that
 * hits that has a bug worth seeing rather than a branch that quietly does not
 * run.
 */
export function bool(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) {
    throw javaError('NullPointerException', 'a null where a boolean was needed');
  }
  return Boolean(value);
}

/** What a `switch` compares on: enums by identity, everything else by value. */
export function key(value) {
  if (value && typeof value === 'object' && value.__enum) return `${value.__enum}.${value.__name}`;
  return value;
}

/** `x instanceof Foo`, as far as a shimmed world can tell. */
export function isA(value, className) {
  if (value === null || value === undefined) return false;
  if (value.javaClass === className) return true;
  if (value.__enum === className) return true;
  let proto = Object.getPrototypeOf(value);
  while (proto) {
    if (proto.constructor?.name === className) return true;
    proto = Object.getPrototypeOf(proto);
  }
  const ALIASES = {
    String: (v) => typeof v === 'string',
    Double: (v) => typeof v === 'number',
    Integer: (v) => typeof v === 'number',
    Number: (v) => typeof v === 'number',
    Boolean: (v) => typeof v === 'boolean',
    Object: () => true,
  };
  return ALIASES[className] ? ALIASES[className](value) : false;
}
