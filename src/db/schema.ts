import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// Enum para estados SRS (estilo Anki) + 'deleted' para Soft-Delete (Tombstone offline-first)
export const srsStateEnum = pgEnum('srs_state', [
  'new',
  'learning',
  'review',
  'suspended',
  'deleted',
]);

// 1. Tabla users
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  fullName: varchar('full_name', { length: 120 }).default('').notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Tabla vocabulary (Los UUIDs se mantienen inmutables mediante UPSERT en el worker ETL)
export const vocabulary = pgTable(
  'vocabulary',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kanji: text('kanji'), // Nullable para palabras que solo se escriben en kana
    reading: text('reading').notNull(),
    meaningEs: text('meaning_es').notNull(),
    meaningEn: text('meaning_en').notNull(),
    jlptLevel: integer('jlpt_level').notNull(),
    partOfSpeech: varchar('part_of_speech', { length: 100 }).notNull(),
    exampleSentence: text('example_sentence'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_vocabulary_jlpt_level').on(table.jlptLevel),
    index('idx_vocabulary_reading').on(table.reading),
    index('idx_vocabulary_updated_at').on(table.updatedAt),
  ]
);

// 3. Tabla srs_reviews
export const srsReviews = pgTable(
  'srs_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vocabularyId: uuid('vocabulary_id')
      .notNull()
      .references(() => vocabulary.id, { onDelete: 'restrict' }),
    state: srsStateEnum('state').default('new').notNull(),
    easeFactor: numeric('ease_factor', { precision: 5, scale: 2 })
      .default('2.50')
      .notNull(),
    intervalDays: integer('interval_days').default(0).notNull(),
    nextReviewDate: timestamp('next_review_date', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lapses: integer('lapses').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_srs_reviews_user_vocabulary').on(
      table.userId,
      table.vocabularyId
    ),
    index('idx_srs_reviews_user_next_review').on(
      table.userId,
      table.nextReviewDate
    ),
    index('idx_srs_reviews_user_updated_at').on(
      table.userId,
      table.updatedAt
    ),
  ]
);

// 4. Tabla user_decks (Mazos personalizados creados por el usuario)
export const userDecks = pgTable(
  'user_decks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    vocabularyIds: jsonb('vocabulary_ids').$type<string[]>().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_user_decks_user_updated_at').on(table.userId, table.updatedAt),
  ]
);

