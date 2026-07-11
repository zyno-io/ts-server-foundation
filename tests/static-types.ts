import type {
    DatabaseField,
    MethodKeys,
    MethodsOf,
    ObjectKeysMatching,
    OptionalNulls,
    Overwrite,
    RequireFields,
    Serializable,
    StringKeyOf,
    UuidString
} from '../src';

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
            ? true
            : false
        : false;
type Expect<T extends true> = T;

declare const symbolKey: unique symbol;

type StringKeyFixture = {
    id: string;
    0: string;
    [symbolKey]: string;
};
type _StringKeyOfOnlyIncludesStringKeys = Expect<Equal<StringKeyOf<StringKeyFixture>, 'id'>>;

type MatchingFixture = {
    id: string;
    nullable: string | null;
    maybeString: string | undefined;
    count: number;
    optionalCount?: number;
    callback: () => void;
};
type _ObjectKeysMatchingString = Expect<Equal<ObjectKeysMatching<MatchingFixture, string>, 'id' | 'nullable' | 'maybeString'>>;
type _ObjectKeysMatchingNumber = Expect<Equal<ObjectKeysMatching<MatchingFixture, number>, 'count' | 'optionalCount'>>;
type _ObjectKeysMatchingExcludesFunctions = Expect<Equal<ObjectKeysMatching<MatchingFixture, (...args: unknown[]) => unknown>, never>>;

type MethodFixture = {
    id: string;
    run(): void;
    stop: () => void;
    maybeRun?: () => void;
    anything: any;
};
type _MethodKeysExcludeNonFunctionsAndAny = Expect<Equal<MethodKeys<MethodFixture>, 'run' | 'stop' | 'maybeRun'>>;
type _MethodsOfIncludesCallableMembers = Expect<Equal<keyof MethodsOf<MethodFixture>, 'run' | 'stop' | 'maybeRun'>>;

type RequiredFixture = RequireFields<{ id?: string; count?: number }, 'id'>;
const requiredFixture: RequiredFixture = { id: 'ok' };
void requiredFixture;

// @ts-expect-error RequireFields should make selected optional fields required.
const missingRequiredFixture: RequiredFixture = {};
void missingRequiredFixture;

type OptionalNullsFixture = OptionalNulls<{
    name: string;
    color: string | null;
    size?: number;
    archived?: boolean | null;
}>;
type _OptionalNullsMakesNullableFieldsOptional = Expect<
    Equal<OptionalNullsFixture, { name: string; size?: number; color?: string | null; archived?: boolean | null }>
>;

type OverwriteFixture = Overwrite<{ id: string; nested?: { enabled: boolean }; label?: string }, { nested?: { enabled?: boolean } }>;
type _OverwriteReplacesDuplicateKeys = Expect<Equal<OverwriteFixture, { id: string; label?: string; nested?: { enabled?: boolean } }>>;

const optionalNullsFixture: OptionalNullsFixture = { name: 'ok' };
void optionalNullsFixture;

const optionalNullsWithNull: OptionalNullsFixture = { name: 'ok', color: null, archived: null };
void optionalNullsWithNull;

// @ts-expect-error OptionalNulls should not make non-nullable fields optional.
const optionalNullsMissingRequired: OptionalNullsFixture = { color: 'red' };
void optionalNullsMissingRequired;

const serializableValue: Serializable = {
    id: '1',
    count: 2,
    flags: [true, false],
    nested: {
        active: true
    }
};
void serializableValue;

// @ts-expect-error Serializable intentionally excludes non-plain runtime objects.
const nonSerializableValue: Serializable = new Date();
void nonSerializableValue;

declare const charUuidField: string & DatabaseField<{ type: 'CHAR(36)' }>;
const uuidStringFromDatabaseField: UuidString = charUuidField;
void uuidStringFromDatabaseField;

const varcharFieldFromCharField: string & DatabaseField<{ type: 'VARCHAR(36)' }> = charUuidField;
void varcharFieldFromCharField;
