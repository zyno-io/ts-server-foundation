# Search Filters

Search boxes often accept free text mixed with `key:value` filters, such as `smith direction:incoming after:"2026-03-10 14:00"`. Two pieces handle this:

- `@zyno-io/ts-utils` is an isomorphic package (browser and Node, no runtime dependencies) with the tokenizer and zoned-date helpers.
- `extractSearchFilters` in `@zyno-io/ts-server-foundation` tokenizes with that package and validates the filters against a TypeScript type.

## extractSearchFilters

```ts
import { extractSearchFilters } from '@zyno-io/ts-server-foundation';

const { text, filters } = extractSearchFilters<{ direction?: 'incoming' | 'outgoing'; after?: string }>(query);
```

- Empty or missing input returns `{}`.
- `text` is the remaining free text, or `undefined` when nothing is left.
- `filters` is `undefined` when no filters were found.
- The type argument is reflected at runtime. A value that does not match throws `HttpUserError` (HTTP 422) with the message `"sideways" is not valid for "direction"`.
- Keys that are absent from `T` are not rejected; they pass through unchanged.

## Tokenizer

```ts
import { composeSearchFilters, parseSearchFilters, removeSearchFilters, replaceSearchFilters } from '@zyno-io/ts-utils';
```

A token is `key:value` or `key:"quoted value"`. A key is one or more characters other than whitespace, `:` and `"`. A value is either a double-quoted string, which may contain spaces, colons and the escapes `\"` and `\\`, or a run of non-whitespace characters that keeps its own colons (`after:2026-03-10T14:00:30`).

| Function                         | Result                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `parseSearchFilters(input)`      | `{ filters, text }`. Values are dequoted and unescaped. For duplicate keys, the last one wins. |
| `removeSearchFilters(input)`     | The free text only, or `''`.                                                                   |
| `composeSearchFilters(values)`   | Tokens joined by single spaces in insertion order. `null`, `undefined` and `''` are skipped.   |
| `replaceSearchFilters(input, v)` | Free text of `input` followed by the composed filters of `v`.                                  |

Each filter is replaced by a space before the free text is collapsed, so `smith after:x jones` becomes `smith jones`. Compose quotes a value that contains whitespace or `"`, so any string round-trips through compose and parse.

Free text that merely looks like a filter is parsed as one. A time such as `10:30` becomes the filter `10` with value `30`, and a URL such as `http://x.com/a` becomes the filter `http` with value `//x.com/a`. A token with no value (`after:`) stays in the text.

## Zoned dates

The same package provides date math in an IANA time zone. Instants are computed with `Intl`, so daylight-saving gaps and repeats are handled.

| Function                           | Result                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `validTimeZone(value)`             | The trimmed zone name, or `null` when it is not a usable zone.                                                                        |
| `isDateOnly(value)`                | `true` for a `YYYY-MM-DD` string.                                                                                                     |
| `startOfZonedDay(date, zone)`      | The first instant of the local day, or `null` for a malformed or impossible date.                                                     |
| `zonedDayRange(date, zone)`        | `{ start, end }` for the local day (`[start, end)`).                                                                                  |
| `zonedDateTime(value, zone)`       | The instant of a local `YYYY-MM-DD[T ]HH:MM[:SS]`. A skipped time maps to the end of the gap, a repeated one to its first occurrence. |
| `parseZonedDateBound(value, zone)` | `{ date, zoned }`. Date-only and offset-free date-times are zoned; anything else is parsed with `new Date`.                           |
| `currentZonedYear(zone, now?)`     | The current calendar year in the zone.                                                                                                |
