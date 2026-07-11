import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqlQuery, quoteIdentifier, renderSql, sql } from '../src';

describe('sql', () => {
    it('renders mysql placeholders', () => {
        const query = sql`SELECT * FROM users WHERE id = ${123} AND active = ${true}`;
        assert.deepStrictEqual(renderSql(query, 'mysql'), {
            sql: 'SELECT * FROM users WHERE id = ? AND active = ?',
            bindings: [123, true]
        });
    });

    it('renders postgres placeholders', () => {
        const query = sql`SELECT * FROM users WHERE id = ${123} AND active = ${true}`;
        assert.deepStrictEqual(renderSql(query, 'postgres'), {
            sql: 'SELECT * FROM users WHERE id = $1 AND active = $2',
            bindings: [123, true]
        });
    });

    it('flattens nested fragments', () => {
        const condition = sql`id = ${123}`;
        const query = sql`SELECT * FROM ${sql.identifier('users')} WHERE ${condition}`;
        assert.deepStrictEqual(renderSql(query, 'postgres'), {
            sql: 'SELECT * FROM "users" WHERE id = $1',
            bindings: [123]
        });
    });

    it('joins explicit fragments', () => {
        const ids = [1, 2, 3].map(id => sql`${id}`);
        const query = sql`id IN (${sql.join(ids)})`;
        assert.deepStrictEqual(renderSql(query, 'mysql'), {
            sql: 'id IN (?, ?, ?)',
            bindings: [1, 2, 3]
        });
    });

    it('renders identifiers per dialect', () => {
        assert.equal(quoteIdentifier('user"name', 'postgres'), '"user""name"');
        assert.equal(quoteIdentifier('user`name', 'mysql'), '`user``name`');
    });

    it('supports trusted raw fragments', () => {
        const query = sql`updatedAt = ${sql.rawTrusted('CURRENT_TIMESTAMP')}`;
        assert.deepStrictEqual(renderSql(query, 'postgres'), {
            sql: 'updatedAt = CURRENT_TIMESTAMP',
            bindings: []
        });
    });

    it('creates manual binding queries', () => {
        const query = createSqlQuery('SELECT * FROM users WHERE name LIKE ? AND active = ?', ['a%', true]);
        assert.deepStrictEqual(renderSql(query, 'postgres'), {
            sql: 'SELECT * FROM users WHERE name LIKE $1 AND active = $2',
            bindings: ['a%', true]
        });
    });
});
