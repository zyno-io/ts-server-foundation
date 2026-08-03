# @zyno-io/ts-reflection

Browser-neutral runtime reflection, metadata decoding, validation, and deserialization for TypeScript applications.

Install this package directly in browser applications and shared packages:

```ts
import { ReflectionKind, typeOf, validate } from '@zyno-io/ts-reflection';
```

The optional `@zyno-io/ts-reflection/type-compiler` entrypoint is the `ttsc` plugin. Projects that use it must also install `ttsc` and configure their transform with that subpath. `@zyno-io/ts-reflection/type-metadata-runtime` is emitted only when transformed metadata needs a runtime decoder.

Server applications may continue importing the same runtime APIs and the compiler plugin from `@zyno-io/ts-server-foundation` during the compatibility period.
