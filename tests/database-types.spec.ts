import {
    AutoIncrement,
    BaseEntity,
    databaseAnnotation,
    DateString,
    getEntityMetadata,
    Length,
    MySQLCoordinate,
    PrimaryKey,
    ReflectionKind,
    Type,
    UuidString,
    validate
} from '../src';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('database root exports', () => {
    it('preserves type metadata for database type imports from the package root', () => {
        class DatabaseTypedEntity extends BaseEntity {
            id!: number & PrimaryKey & AutoIncrement;
            uuid!: UuidString;
            date!: DateString;
            code!: Length<6>;
            location!: MySQLCoordinate;
        }

        const errors = validate<{ code: Length<6>; date: DateString }>({
            code: '123',
            date: 'not-a-date'
        });
        const metadata = getEntityMetadata(DatabaseTypedEntity);
        const columns = Object.fromEntries(metadata.columns.map(column => [column.propertyName, column]));

        assert.equal(errors.length, 2);
        assert.equal(errors[0].code, 'minLength');
        assert.equal(errors[1].code, 'pattern');
        assert.equal(hasTypeName(columns.uuid.type, 'UuidString'), true);
        assert.equal(hasTypeName(columns.date.type, 'DateString'), true);
        assert.equal(hasTypeName(columns.location.type, 'MySQLCoordinate'), true);
        assert.deepEqual(databaseAnnotation.getDatabase(columns.location.type, 'mysql'), { type: 'point' });
    });
});

function hasTypeName(type: Type, name: string): boolean {
    if ((type as Type & { typeName?: string }).typeName === name) return true;
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        return type.types.some(item => hasTypeName(item, name));
    }
    return false;
}
