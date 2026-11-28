# @zyno-io/ts-utils

Isomorphic (browser and Node) TypeScript utilities with zero runtime dependencies.

- `zoned-date`: IANA-zone date math (`startOfZonedDay`, `zonedDayRange`, `zonedDateTime`, `parseZonedDateBound`, `currentZonedYear`, `validTimeZone`, `isDateOnly`).
- `search-filters`: a tokenizer for `key:value` and `key:"quoted value"` search boxes (`parseSearchFilters`, `removeSearchFilters`, `composeSearchFilters`, `replaceSearchFilters`).

```ts
import { composeSearchFilters, parseSearchFilters } from '@zyno-io/ts-utils';

parseSearchFilters('smith after:"2026-03-10 14:00"');
// { filters: { after: '2026-03-10 14:00' }, text: 'smith' }
composeSearchFilters({ after: '2026-03-10 14:00', direction: null });
// 'after:"2026-03-10 14:00"'
```

Server applications can validate parsed filters against a TypeScript type with `extractSearchFilters` from `@zyno-io/ts-server-foundation`.

## License

MIT. See [LICENSE](LICENSE).
