import { buildPromptMap, normalizeTag, validateTag } from "./tag-utils.js";

const DB_NAME = "promptbin";
const DB_VERSION = 1;
const STORE_NAME = "prompts";

let dbPromise;

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  const pendingOpen = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "tagKey"
        });
        store.createIndex("updatedAt", "updatedAt");
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (dbPromise === pendingOpen) {
          dbPromise = undefined;
        }
      };
      resolve(database);
    };
    request.onerror = () => {
      if (dbPromise === pendingOpen) {
        dbPromise = undefined;
      }
      reject(request.error ?? new Error("Failed to open PromptBin database."));
    };
  });

  dbPromise = pendingOpen;
  return dbPromise;
}

async function withStore(mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    let callbackResult;
    try {
      callbackResult = callback(store, transaction);
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(callbackResult);
    transaction.onerror = () => reject(transaction.error ?? new Error("PromptBin database transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("PromptBin database transaction was aborted."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function normalizeTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

export async function listPrompts() {
  return withStore("readonly", async (store) => {
    const prompts = await requestToPromise(store.getAll());
    return prompts.sort((left, right) => {
      const updatedLeft = new Date(left.updatedAt).getTime();
      const updatedRight = new Date(right.updatedAt).getTime();
      return updatedRight - updatedLeft;
    });
  });
}

export async function getPromptByTag(tag) {
  const normalized = validateTag(tag);
  return withStore("readonly", (store) => requestToPromise(store.get(normalized)));
}

export async function savePrompt(input) {
  const tag = validateTag(input.tag);
  const prompt = String(input.prompt ?? "");

  if (!prompt.trim()) {
    throw new Error("Prompt content cannot be empty.");
  }

  const now = new Date().toISOString();
  const existing = await getPromptByTag(tag);
  const record = {
    tag,
    tagKey: tag,
    prompt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    characterCount: prompt.length
  };

  await withStore("readwrite", (store) => {
    store.put(record);
  });

  return record;
}

export async function deletePrompt(tag) {
  const tagKey = validateTag(tag);
  await withStore("readwrite", (store) => {
    store.delete(tagKey);
  });
}

export async function markPromptsUsed(tags) {
  const tagKeys = [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
  if (!tagKeys.length) {
    return [];
  }

  const usedAt = new Date().toISOString();
  await withStore("readwrite", async (store) => {
    const prompts = await Promise.all(tagKeys.map((tagKey) => requestToPromise(store.get(tagKey))));

    prompts.filter(Boolean).forEach((prompt) => {
      store.put({
        ...prompt,
        lastUsedAt: usedAt,
        useCount: Number(prompt.useCount ?? 0) + 1
      });
    });
  });

  return tagKeys;
}

export async function exportLibrary() {
  const prompts = await listPrompts();
  return {
    exportedAt: new Date().toISOString(),
    prompts
  };
}

export async function importLibrary(input, options = {}) {
  const replaceExisting = Boolean(options.replaceExisting);
  const rawPrompts = Array.isArray(input) ? input : input?.prompts;

  if (!Array.isArray(rawPrompts)) {
    throw new Error("Import file must contain a prompts array.");
  }

  const importedAt = new Date().toISOString();
  const normalizedPrompts = rawPrompts.map((entry) => {
    const tag = validateTag(entry.tag);
    const prompt = String(entry.prompt ?? "");

    if (!prompt.trim()) {
      throw new Error(`Prompt for ${tag} is empty.`);
    }

    const record = {
      tag,
      tagKey: tag,
      prompt,
      characterCount: prompt.length,
      createdAt: normalizeTimestamp(entry.createdAt, importedAt),
      updatedAt: normalizeTimestamp(entry.updatedAt, importedAt)
    };

    const lastUsedAt = normalizeTimestamp(entry.lastUsedAt, null);
    if (lastUsedAt) {
      record.lastUsedAt = lastUsedAt;
    }

    const useCount = Number(entry.useCount);
    if (Number.isSafeInteger(useCount) && useCount > 0) {
      record.useCount = useCount;
    }

    return record;
  });

  await withStore("readwrite", (store) => {
    if (replaceExisting) {
      store.clear();
    }

    normalizedPrompts.forEach((prompt) => {
      store.put(prompt);
    });
  });

  return listPrompts();
}

export async function getLibrarySnapshot() {
  const prompts = await listPrompts();
  const totalCharacters = prompts.reduce((sum, prompt) => sum + (prompt.characterCount || prompt.prompt.length), 0);
  const recentlyUsed = prompts
    .filter((prompt) => prompt.lastUsedAt)
    .sort((left, right) => new Date(right.lastUsedAt).getTime() - new Date(left.lastUsedAt).getTime());

  return {
    prompts,
    recentPrompts: recentlyUsed,
    promptMap: buildPromptMap(prompts),
    stats: {
      promptCount: prompts.length,
      totalCharacters
    }
  };
}
