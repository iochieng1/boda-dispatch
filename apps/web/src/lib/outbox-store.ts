import {
  MemoryMutationStore,
  type MutationStore,
  type NewMutation,
  type QueuedMutation,
} from "./outbox";

const DB_NAME = "boda-dispatch";
const DB_VERSION = 1;
const STORE = "mutations";

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });

/**
 * The outbox in IndexedDB, so changes made offline survive a reload. The key
 * is an auto-incremented `seq`, which gives the queue its order across tabs.
 */
export class IndexedDbMutationStore implements MutationStore {
  private db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, {
        keyPath: "seq",
        autoIncrement: true,
      });
      store.createIndex("dispatcherId", "dispatcherId");
    };
    this.db = request(open);
  }

  private async run<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const tx = (await this.db).transaction(STORE, mode);
    // Awaited together, so a failed write can't leave either rejection
    // unhandled.
    const [result] = await Promise.all([
      request(fn(tx.objectStore(STORE))),
      done(tx),
    ]);
    return result;
  }

  async list(dispatcherId: string) {
    // Index entries with equal keys come back in primary-key (seq) order.
    return this.run<QueuedMutation[]>("readonly", (store) =>
      store.index("dispatcherId").getAll(dispatcherId),
    );
  }

  async add(mutation: NewMutation) {
    const seq = await this.run("readwrite", (store) => store.add(mutation));
    return { ...mutation, seq: seq as number } as QueuedMutation;
  }

  async put(mutation: QueuedMutation) {
    await this.run("readwrite", (store) => store.put(mutation));
  }

  async remove(mutation: QueuedMutation) {
    await this.run("readwrite", (store) => store.delete(mutation.seq));
  }
}

/**
 * IndexedDB when the browser has it; otherwise (some private modes) memory,
 * so changes still queue and replay, just not across a reload.
 */
export const openMutationStore = async (): Promise<MutationStore> => {
  if (typeof indexedDB === "undefined") return new MemoryMutationStore();
  const store = new IndexedDbMutationStore(indexedDB);
  try {
    await store.list("");
    return store;
  } catch {
    return new MemoryMutationStore();
  }
};
