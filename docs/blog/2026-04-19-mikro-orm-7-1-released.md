---
slug: mikro-orm-7-1-released
title: 'MikroORM 7.1'
authors: [B4nan]
tags: [typescript, javascript, node, sql]
image: './img/og-v7-1.png'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

[MikroORM v7.1](https://github.com/mikro-orm/mikro-orm/releases/tag/v7.1.0) is out. The first minor on top of [v7](https://mikro-orm.io/blog/mikro-orm-7-released) is a feature-packed one — a new relation flavor, per-parent collection limiting, database triggers, PostgreSQL partitioning, union-target polymorphic M:N, server-side row cloning, and a lot more. Let's go through the highlights.

<img src={require('./img/og-v7-1.png').default} style={{maxHeight: 450}} />

<!--truncate-->

## `LazyRef<T>` — a new relation flavor

MikroORM has had two ways to type to-one relations for a long time: plain entity references (which pretend the relation is always there at the type level, even when it's not loaded) and `Ref<T>`/`Reference<T>` (which force you to go through `.$` or `.get()` even after you loaded them).

v7.1 introduces a third option: `LazyRef<T>`. It is a **type-only marker** — the runtime is a plain entity, `instanceof` still returns `true`, there's no `.$` or `.get()` indirection. TypeScript restricts access to the primary key until `Loaded<>` narrows it back to the full entity:

```ts
@ManyToOne(() => Author)
author!: LazyRef<Author>;

// or via defineEntity:
author: () => p.manyToOne(AuthorSchema).lazyRef()

book.author.id;                          // ok — PK is always accessible
book.author.name;                        // compile error — not loaded

const loaded = await em.findOneOrFail(Book, 1, { populate: ['author'] });
loaded.author.name;                      // ok — Loaded<> strips the brand
```

Two related additions round out the story:

The **`Loadable` mixin** adds `load()` / `loadOrFail()` to an entity's prototype — Reference-style ergonomics for direct and LazyRef-typed relations. It ships as `Loadable(Base)` plus a pre-composed `LoadableBaseEntity`. `BaseEntity` itself is deliberately untouched so the `load`/`loadOrFail` names stay free on your existing subclasses:

```ts
class User extends LoadableBaseEntity { /* ... */ }
await user.load();          // Promise<User | null>
await user.loadOrFail();    // Promise<User>
```

The **`unref()`** helper is a typed escape hatch — the inverse of the existing `ref()` helper. It narrows `Ref<T> | LazyRef<T> | T` down to `T` for cases where you know the relation is populated but can't thread `Loaded<>` through a function signature:

```ts
import { unref } from '@mikro-orm/core';

function logAuthor(book: Book) {
  // book.author is typed as LazyRef<Author> — .name would be a compile error
  console.log(unref(book.author).name);
}
```

All three additions are opt-in and non-breaking. `BaseEntity`, `Ref<T>`, plain relations and `@ManyToOne({ ref: true })` are unchanged.

## Per-parent limiting for populated collections

A long-requested feature ([#1059](https://github.com/mikro-orm/mikro-orm/issues/1059)) has finally landed. You can now limit how many items each parent gets in a populated collection — e.g. "4 most recent posts per user":

```ts
const users = await em.find(User, {}, {
  populate: ['posts'],
  populateHints: {
    posts: { limit: 4, orderBy: { createdAt: 'desc' } },
  },
});
```

On SQL, this uses `ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY ...)` wrapped in a subquery. On MongoDB, it uses a `$group` / `$push` / `$slice` aggregation pipeline. Limited collections are marked partial and read-only so the Unit of Work doesn't try to delete unloaded items, and the `joined` strategy automatically falls back to `select-in` when a limit is set.

## `em.countBy()` for grouped counts

`em.count()` has always returned a single number. There's now an `em.countBy()` method for the common case where you want to group counts by one or more properties:

```ts
const counts = await em.countBy(Book, 'author');
// { '1': 2, '2': 1, '3': 3 }

const counts = await em.countBy(Order, ['status', 'country']);
// { 'pending~~~US': 5, 'shipped~~~DE': 3 }
```

For composite keys, the result keys are joined with `~~~` (the same separator the ORM uses internally for composite PKs). SQL generates a single `GROUP BY` query; MongoDB uses a `$group` aggregation pipeline. The method is also exposed on `EntityRepository` as `repo.countBy(...)`.

## Dataloader for `Collection.loadCount()`

Building on top of `countBy`, `Collection.loadCount()` now supports dataloader batching. Multiple count calls in the same tick are grouped into a single query — for 1:M relations that's a single `GROUP BY` query via `em.countBy()`; for M:N it falls back to parallel `em.count()` calls with entity filters correctly applied.

```ts
const counts = await Promise.all(
  users.map(u => u.posts.loadCount({ dataloader: true })),
);
```

It also respects the global `DataloaderType.ALL` / `COLLECTION` config, so you can enable it project-wide without the per-call option.

## Database triggers

The schema generator now manages database triggers as first-class citizens. You can define them via the `@Trigger()` decorator or the `triggers` option in `defineEntity`/`EntitySchema`:

```ts
@Trigger({
  name: 'update_timestamp',
  timing: 'before',
  events: ['insert', 'update'],
  body: `NEW.updated_at = NOW(); RETURN NEW`,
})
@Entity()
class Product {

  @PrimaryKey()
  id!: number;

  @Property()
  updatedAt!: Date;

}
```

With `defineEntity`, the `body` can be a callback that receives column name mappings (just like check constraints), so you don't have to hardcode column names:

```ts
const Product = defineEntity({
  name: 'Product',
  properties: p => ({ /* ... */ }),
  triggers: [{
    name: 'update_timestamp',
    timing: 'before',
    events: ['insert', 'update'],
    body: columns => `NEW.${columns.updatedAt} = NOW(); RETURN NEW`,
  }],
});
```

Triggers are created, diffed, and dropped during schema updates like any other schema object. Driver-specific DDL covers PostgreSQL (function + trigger), MySQL/MariaDB/SQLite (one per event — these databases require it), and MSSQL (multi-event, `after` / `instead of` only). Schema introspection round-trips cleanly, so there are no spurious diffs.

## Union-target polymorphic M:N

v7 shipped Rails-style polymorphic M:N — one owner with a `Collection<T>` where the pivot row's discriminator selects which concrete table the row points to. v7.1 adds the mirror shape: a single owner holding a `Collection<A | B>` where each pivot row's discriminator selects the target table:

```ts
@Entity()
class Post {

  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @ManyToMany({
    entity: () => [Image, Video],
    pivotTable: 'attachables',
    discriminator: 'attachable',
    owner: true,
  })
  attachments = new Collection<Image | Video>(this);

}
```

The pivot `(post_id, attachable_type, attachable_id)` has a composite PK and no FK on `attachable_id`. Each target can declare an inverse collection back — those automatically filter the shared pivot by the target's own discriminator value (so `Image.posts` sees only `attachable_type='image'` rows).

> The `defineEntity` DSL doesn't support union targets for M:N yet — the `.manyToMany()` builder accepts a single `EntityTarget` today. Rails-style polymorphic M:N (single target, pivot-row discriminator) is available in both forms.

## PostgreSQL table partitioning

PostgreSQL declarative partitioning is now supported via a new `partitionBy` entity option. Hash, list, and range partitions are all covered:

```ts
@Entity({
  partitionBy: {
    type: 'hash',
    expression: ['type'],
    partitions: 16,
  },
})
class Event {

  @PrimaryKey()
  type!: string;

  @PrimaryKey()
  id!: number;

}
```

The schema generator emits both the parent table DDL (`PARTITION BY ...`) and the child partition DDL, and the PostgreSQL introspection correctly round-trips partitioned tables so there are no perpetual diffs.

## Type-safe index hints via `using`

A new `using` option in `FindOptions` validates `where` / `orderBy` against named indexes and emits driver-specific SQL hints:

```ts
const users = await em.find(User, { name: 'foo' }, {
  using: 'idx_user_name',
});

// also accepts an array of indexes
em.find(User, { name: 'foo' }, { using: ['idx_user_name', 'uniq_user_email'] });
```

The type system narrows `where` to only allow properties covered by the named index(es), and the index name itself is checked against your entity's declared indexes. For `defineEntity`, index names are inferred automatically from `.index('name')` / `.unique('name')` calls; for decorator entities you declare them via the `[IndexHints]` symbol (same pattern as `[PrimaryKeyProp]`).

Driver support includes MySQL/MariaDB (`USE INDEX`), MSSQL (`WITH (INDEX(...))`), MongoDB (passed as the `hint` option), and validation-only on PostgreSQL/SQLite/libSQL. The existing `indexHint` option still works and takes precedence when explicitly set.

## Partial indexes via `where`

`@Index` / `@Unique` (and the `defineEntity` / `EntitySchema` equivalents) now accept a portable `where` predicate — e.g. for a soft-delete-aware unique index on `email`:

```ts
@Unique({ properties: ['email'], where: '"deleted_at" is null' })
```

Per-driver output:

| Driver        | Output                                                                     |
|---------------|----------------------------------------------------------------------------|
| PostgreSQL    | native partial index: `create unique index ... where "deleted_at" is null` |
| SQLite        | native partial index                                                       |
| MSSQL         | native partial index                                                       |
| MySQL 8.0.13+ | functional index: `((case when deleted_at is null then email end))`        |
| Oracle        | functional index, same shape as MySQL                                      |
| MongoDB       | `partialFilterExpression` (object form only)                               |
| MariaDB       | throws — no inline expression indexes; use a virtual generated column      |

The `CASE WHEN` trick on MySQL/Oracle works because `NULL` is distinct in unique indexes — rows where the predicate is false get a `NULL` key and don't conflict.

Predicates are diffed **structurally** through the same expression normalizer the schema generator uses for check constraints (collapsing whitespace, quoting, and casing), so there's no name-only fallback and the output round-trips cleanly through the entity generator.

## Server-side row cloning

Two new complementary APIs for copying rows without round-tripping the data through Node.js:

```ts
// EntityManager: clone by class + where + overrides
const cloned = await em.clone(Author, { id: 1 }, { email: 'new@email.com' });

// or clone a loaded entity directly
const author = await em.findOneOrFail(Author, 1);
const cloned = await em.clone(author, { email: 'new@email.com' });

// QueryBuilder: INSERT INTO ... SELECT
const qb = em.qb(Book).insertFrom(
  em.qb(Book, 'b').select('*').where({ archived: false }),
);
```

`em.clone()` returns a hydrated entity (registered in the identity map) and delegates to a new `driver.nativeClone()` method. It handles TPT inheritance (multi-table inserts), embedded properties, M:1 FK preservation, and version property reset automatically. `qb.insertFrom()` is the lower-level building block, with 3-tier column derivation: metadata-driven, select-field-driven, or explicit.

Works across all SQL drivers; MongoDB uses a find+insert fallback.

## `fields` whitelist in `serialize()`

`serialize()` used to only support `exclude` (a denylist). v7.1 adds a first-class `fields` whitelist, so callers can guarantee an allowlist-based response shape — exactly what you want when protecting API responses from accidentally exposing newly added entity properties:

```ts
serialize(user, { fields: ['name'] });
// { name: 'Jon Snow' } — no PK, no other fields

serialize(jon, { populate: ['books'], fields: ['name', 'books.title'] });
// { name: 'Jon Snow', books: [{ title: '...' }] }

wrap(jon).serialize({ fields: ['id', 'name'] });
```

The semantics are strict — unlike the partial-loading `toObject()` path, PKs are dropped unless listed explicitly. `exclude` wins on conflict, so `{ fields: ['name', 'email'], exclude: ['email'] }` returns just `{ name }`. The return type narrows end to end.

## `discovery:export` — typed entities barrel for folder-discovered projects

One of the headline type-safety wins in v7 was that `em.getKysely()` returns a fully-typed Kysely instance — but only when the ORM knows your entities at the type level. With `defineEntity`, that happens automatically. With decorators, you get it by listing entities explicitly in your config. If you rely on **folder discovery** (globs via `entities: ['./dist/**/*.entity.js']`), the config loses the type-level view of your schema, and `getKysely<Database>()` falls back to `any`.

This is particularly painful in NestJS and similar DI-driven setups, where folder discovery is the idiomatic way to register entities and the ORM config can't easily reference each entity class directly.

The new `discovery:export` CLI command closes that gap. It scans your entity source files and emits a TypeScript barrel:

```bash
mikro-orm discovery:export --path './src/entities/*.ts' --out ./entities.generated.ts
```

The generated file gives you two exports:

- **`export const entities = [...] as const`** — drop it straight into your ORM config in place of the glob. The ORM keeps doing folder-style registration, but the config now carries the exact set of entity classes at the type level.
- **`export type Database = ...`** — the Kysely `Database` interface, derived from your entity metadata. Use it as `em.getKysely<Database>()` and get autocomplete for every table and column, with the naming strategy applied.

Re-run the command whenever your entity set changes (or wire it into your build step). No decorator changes, no migration away from folder discovery — just typed Kysely queries across the stack.

## Runtime schema context for migrations

Two long-standing pain points around migrations and schemas are now addressed by a single new mechanism: a **runtime schema context** that redirects existing migrations to a target schema without regenerating them.

```ts
// per-deployment-one-schema (e.g. PR previews)
await MikroORM.init({
  migrations: { schema: process.env.PR_PREVIEW_SCHEMA },
});

// or fan a single migration set out to many tenant schemas
for (const tenant of tenants) {
  await orm.migrator.up({ schema: tenant });
}
```

When a runtime schema is resolved, the migrator prepends the driver's "set current schema" statement before each migration and resets it in a `finally` block so the pooled connection isn't left pointing at the migration's target schema. The tracking table follows the same schema, so each target gets its own independent migration history (matches Flyway/Liquibase semantics).

| Driver           | Set                                       | Reset                                            |
|------------------|-------------------------------------------|--------------------------------------------------|
| PostgreSQL       | ``SET search_path TO "x"``                | `RESET search_path`                              |
| MySQL / MariaDB  | `` USE `x` ``                             | `` USE `<config.dbName>` ``                      |
| Oracle           | ``ALTER SESSION SET CURRENT_SCHEMA = "x"``| ``ALTER SESSION SET CURRENT_SCHEMA = "<dbName>"``|
| MSSQL            | unsupported — throws                      | —                                                |
| SQLite / libSQL  | schemaless — silent no-op                 | —                                                |

For the multi-tenant case, opt wildcard entities (`@Entity({ schema: '*' })`) into `migration:create` with `migrations.includeWildcardSchema: true` so the emitted DDL is unqualified and safe to apply against any schema. Tenant orchestration and failure recovery remain the caller's responsibility — this ships primitives, not a managed multi-tenant migrator.

The CLI gets a matching `--schema` flag on `migration:up` / `migration:down`, and `migrator.getExecuted({ schema })` / `getPending({ schema })` let you inspect per-tenant state without mutating global config. Strictly additive — nothing changes unless you opt in.

## CLI: more migration commands

Two other CLI additions on the migrations side:

- **`migration:rollup`** combines multiple executed migrations into a single migration file. It's a pure file operation — it extracts `up()` / `down()` bodies and concatenates them (up in chronological order, down in reverse), then updates the migration log table. No schema changes, zero risk of data loss. Works for both SQL and MongoDB migrations.

- **`migration:log`** / **`migration:unlog`** mark a migration as executed (or not) without actually running (or reverting) it. Useful when bootstrapping a project from an existing database, or when recovering after a partial migration failure.

## Smaller improvements

A few more additions worth mentioning:

- **`array: true` on scalar properties** — you can now write `@Property({ type: IntegerType, array: true })` or `p.integer().array()` and the ORM will wrap the inner type in an `ArrayType` and infer the column type as `int[]` / `text[]` / etc. automatically.
- **`initNullableProperties` config option** — opt-in behavior that initializes nullable properties to `null` when omitted from `em.create()` data, so the runtime value matches the type contract and the database representation from the start.
- **`defineEntity` with `extends`** — the auto-generated class now extends the parent class at the JS level, so property initializers from the base class actually run. Previously only `BaseEntity` was special-cased.
- **`chunkSize` option on streams** — lets you tune the batch size used when iterating results via `em.stream()` for large exports.

## What do you think?

Those were the highlights. There are more improvements and bug fixes throughout — check the [full changelog](https://github.com/mikro-orm/mikro-orm/releases/tag/v7.1.0) for the complete list, and let us know what you think in the comments!
