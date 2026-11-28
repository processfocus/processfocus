import { rmSync } from "node:fs"

export const cleanupTestDatabase = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-tshm", "-twal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true })
  }
}
