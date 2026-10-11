/*
A reference counting cache.

See example usage in conat/sync.
*/

import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import jsonStableStringify from "json-stable-stringify";
const VERBOSE = false;

export const caches: { [name: string]: any } = {};

export function info() {
  const x: any = {};
  for (const name in caches) {
    x[name] = caches[name].info();
  }
  return x;
}

export default function refCache<
  Options extends { noCache?: boolean },
  T extends { close: () => void | Promise<void> },
>({
  createKey,
  createObject,
  isValid,
  name,
}: {
  createKey?: (opts: Options) => string | null | undefined;
  createObject: (opts: Options) => Promise<T>;
  isValid?: (obj: T) => boolean;
  name: string;
}) {
  interface Entry {
    obj: T;
    count: number;
    closed: boolean;
    close: () => void | Promise<void>;
  }
  const cache: { [key: string]: Entry } = {};
  if (createKey == null) {
    createKey = (x) => jsonStableStringify(x) ?? "";
  }
  const createObjectReuseInFlight = reuseInFlight(createObject, {
    createKey: (args) => createKey(args[0]) ?? "",
  });

  const get = async (opts: Options): Promise<T> => {
    if (opts.noCache) {
      return await createObject(opts);
    }
    const key = createKey(opts) ?? "";
    let entry: Entry | undefined = cache[key];
    if (entry != null && isValid != null && !isValid(entry.obj)) {
      delete cache[key];
      entry = undefined;
    }
    if (entry != null) {
      entry.count += 1;
      if (VERBOSE) {
        console.log("refCache: cache hit", {
          name,
          key,
          count: entry.count,
        });
      }
      return entry.obj;
    }
    const obj = await createObjectReuseInFlight(opts);
    if (VERBOSE) {
      console.log("refCache: create", { name, key });
    }
    if (cache[key] != null) {
      // it's possible after the above await that a
      // different call to get already setup the cache, count, etc.
      cache[key].count += 1;
      return cache[key].obj;
    }
    // we are *the* one setting things up.
    const newEntry: Entry = {
      obj,
      count: 1,
      closed: false,
      close: obj.close,
    };
    cache[key] = newEntry;
    obj.close = (() => {
      if (newEntry.closed) {
        console.warn(
          "WARNING: bug called .close() too many times on an object",
          { name, key },
        );
        return;
      }
      newEntry.count -= 1;
      if (VERBOSE) {
        console.log("refCache: close", {
          name,
          key,
          count: newEntry.count,
        });
      }
      // make it so calling close again is a no-op
      if (newEntry.count <= 0) {
        newEntry.closed = true;
        const result = newEntry.close();
        if (cache[key] === newEntry) {
          delete cache[key];
        }
        return result;
      }
    }) as T["close"];

    return obj;
  };
  get.info = () => {
    const count: { [key: string]: number } = {};
    for (const key in cache) {
      count[key] = cache[key].count;
    }
    return { name, count };
  };
  get.one = (): T | undefined => {
    for (const key in cache) {
      return cache[key].obj;
    }
  };
  get.size = () => {
    // size is currently just used for unit testing, so no attempt made to make this fast.
    return Object.keys(cache).length;
  };
  caches[name] = get;
  return get;
}

export function refCacheSync<
  Options extends { noCache?: boolean },
  T extends { close: () => void },
>({
  createKey,
  createObject,
  isValid,
  name,
}: {
  createKey?: (opts: Options) => string | null | undefined;
  createObject: (opts: Options) => T;
  // An invalid cached object is no longer handed out; the next get creates a
  // replacement.  Holders of the old object keep their references, and their
  // close() calls only release the old object.
  isValid?: (obj: T) => boolean;
  name: string;
}) {
  interface Entry {
    obj: T;
    count: number;
    closed: boolean;
    close: () => void;
  }
  const cache: { [key: string]: Entry } = {};
  if (createKey == null) {
    createKey = (x) => jsonStableStringify(x) ?? "";
  }
  const get = (opts: Options): T => {
    if (opts.noCache) {
      return createObject(opts);
    }
    const key = createKey(opts) ?? "";
    let entry: Entry | undefined = cache[key];
    if (entry != null && isValid != null && !isValid(entry.obj)) {
      delete cache[key];
      entry = undefined;
    }
    if (entry != null) {
      entry.count += 1;
      if (VERBOSE) {
        console.log("refCacheSync: cache hit", {
          name,
          key,
          count: entry.count,
        });
      }
      return entry.obj;
    }
    const obj = createObject(opts);
    if (VERBOSE) {
      console.log("refCacheSync: create", { name, key });
    }
    // we are *the* one setting things up.
    const newEntry: Entry = { obj, count: 1, closed: false, close: obj.close };
    cache[key] = newEntry;
    obj.close = () => {
      if (newEntry.closed) {
        console.warn(
          "WARNING: bug called .close() too many times on an object",
          { name, key },
        );
        return;
      }
      newEntry.count -= 1;
      if (VERBOSE) {
        console.log("refCacheSync: close", {
          name,
          key,
          count: newEntry.count,
        });
      }
      if (newEntry.count <= 0) {
        newEntry.closed = true;
        newEntry.close();
        if (cache[key] === newEntry) {
          delete cache[key];
        }
      }
    };

    return obj;
  };
  get.info = () => {
    const count: { [key: string]: number } = {};
    for (const key in cache) {
      count[key] = cache[key].count;
    }
    return { name, count };
  };
  get.one = (): T | undefined => {
    for (const key in cache) {
      return cache[key].obj;
    }
  };
  get.size = () => {
    // size is currently just used for unit testing, so no attempt made to make this fast.
    return Object.keys(cache).length;
  };
  caches[name] = get;
  return get;
}
