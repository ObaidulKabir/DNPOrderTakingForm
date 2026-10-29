import { createApp } from './app.js';
import { createContainer } from './container.js';
import { IDataRepository } from './repositories/IDataRepository.js';
import { JsonCsvDataRepository } from './repositories/JsonCsvDataRepository.js';
import { PostgresDataRepository } from './repositories/PostgresDataRepository.js';
import { SqliteDataRepository } from './repositories/SqliteDataRepository.js';

const PORT = Number(process.env.PORT || 3000);
// Default storage mode is now PostgreSQL (Relational + JSONB)
const STORAGE_MODE = (process.env.STORAGE_MODE || 'postgres').toLowerCase();

async function bootstrap() {
  const jsonRepo = new JsonCsvDataRepository();
  let repo: IDataRepository;

  if (STORAGE_MODE === 'postgres' || STORAGE_MODE === 'pg') {
    repo = await PostgresDataRepository.create({
      connectionString: process.env.DATABASE_URL,
      dataDir: process.env.PGDATA_DIR, // undefined = fast embedded Postgres in-memory seeded from data/
      seedFrom: jsonRepo,
    });
  } else if (STORAGE_MODE === 'sqlite') {
    repo = await SqliteDataRepository.createSeeded(jsonRepo, process.env.SQLITE_PATH || ':memory:');
  } else {
    repo = jsonRepo;
  }

  const container = createContainer(repo);
  const app = createApp(container);

  app.listen(PORT, () => {
    console.log(
      `PrintPilot server listening on http://localhost:${PORT} (storage: ${STORAGE_MODE}${
        STORAGE_MODE.startsWith('pg') || STORAGE_MODE === 'postgres'
          ? process.env.DATABASE_URL
            ? ' [external PostgreSQL]'
            : ' [embedded PostgreSQL + JSONB]'
          : ''
      })`
    );
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
