import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// Enum para estados SRS (estilo Anki)
export const srsStateEnum = pgEnum('srs_state', [
  'new',
  'learning',
  'review',
  'suspended',
]);

// 1. Tabla users
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Tabla vocabulary
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
      .references(() => vocabulary.id, { onDelete: 'cascade' }),
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
