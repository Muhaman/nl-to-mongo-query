import { MongoClient, type Db } from "mongodb";

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/** One client per process: the driver pools connections internally. */
export async function connectDatabase(uri: string, name: string): Promise<Database> {
  const client = await MongoClient.connect(uri);
  return { db: client.db(name), close: () => client.close() };
}
