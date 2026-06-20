import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryVideoLibraryStore,
  RestVideoLibraryStore,
  VideoLibraryService,
  classifyArticleChange,
  createArticleSnapshot,
  createVideoLibraryStore,
} from "../lib/video/library.js";

function snapshot(overrides = {}) {
  return {
    exactHash: "revision-a",
    normalizedTitle: "example",
    facts: [],
    wordCount: 100,
    signature: ["shared"],
    ...overrides,
  };
}

test("20 percent word-count change is material", () => {
  const previous = snapshot();
  assert.equal(
    classifyArticleChange(previous, snapshot({ exactHash: "b", wordCount: 119 })).material,
    false,
  );

  const result = classifyArticleChange(previous, snapshot({ exactHash: "c", wordCount: 120 }));
  assert.equal(result.material, true);
  assert.equal(result.reason, "length_changed");
});

test("minor edits accumulate against the last material revision", async () => {
  const service = new VideoLibraryService(new MemoryVideoLibraryStore());
  const phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa ";
  const article = {
    title: "Cumulative changes",
    url: "https://iq.wiki/wiki/cumulative-changes",
    rawText: phrase.repeat(10),
  };

  const first = await service.syncArticle(article);
  await service.publishAsset({
    url: article.url,
    revision: first.revision,
    playbackUrl: "https://cdn.example.com/cumulative.mp4",
  });

  const minor = await service.syncArticle({
    ...article,
    rawText: phrase.repeat(11),
  });
  assert.equal(minor.state, "ready");

  const material = await service.syncArticle({
    ...article,
    rawText: phrase.repeat(12),
  });
  assert.equal(material.state, "needs_generation");
  assert.equal(material.asset, null);
});

test("title and factual value changes are material", () => {
  const previous = snapshot({ facts: ["15", "0xabc"] });
  assert.equal(
    classifyArticleChange(previous, snapshot({ exactHash: "b", normalizedTitle: "renamed" })).reason,
    "title_changed",
  );
  assert.equal(
    classifyArticleChange(previous, snapshot({ exactHash: "c", facts: ["20", "0xabc"] })).reason,
    "facts_changed",
  );
});

test("malformed article payload returns a client error", () => {
  assert.throws(
    () => createArticleSnapshot(null),
    (error) => error.code === "INVALID_ARTICLE" && error.status === 400,
  );
});

test("malformed video asset payload returns a client error", async () => {
  const service = new VideoLibraryService(new MemoryVideoLibraryStore());
  await assert.rejects(
    service.publishAsset(null),
    (error) => error.code === "INVALID_VIDEO_ASSET" && error.status === 400,
  );
});

test("unconfigured production library reads as empty but rejects writes", async () => {
  const service = new VideoLibraryService(createVideoLibraryStore({
    NODE_ENV: "production",
  }));
  const url = "https://iq.wiki/wiki/solana";

  assert.deepEqual(await service.lookup(url), {
    state: "missing",
    article: { url },
  });

  await assert.rejects(
    service.syncArticle({
      title: "Solana",
      url,
      rawText: "Solana is a blockchain network designed for fast transactions. ".repeat(20),
    }),
    (error) => error.code === "VIDEO_LIBRARY_NOT_CONFIGURED" && error.status === 503,
  );
});

test("partial production library configuration remains fatal", () => {
  assert.throws(
    () => createVideoLibraryStore({
      NODE_ENV: "production",
      VIDEO_LIBRARY_REST_URL: "https://storage.example.com",
    }),
    (error) => error.code === "VIDEO_LIBRARY_CONFIGURATION_ERROR" && error.status === 503,
  );
});

test("rejects unsafe video library endpoints and blank tokens", () => {
  for (const url of [
    "http://storage.example.com",
    "https://user:pass@storage.example.com",
    "https://storage.example.com/?command=GET",
  ]) {
    assert.throws(
      () => new RestVideoLibraryStore({ url, token: "token" }),
      (error) =>
        error.code === "VIDEO_LIBRARY_CONFIGURATION_ERROR" &&
        error.status === 503,
    );
  }

  assert.throws(
    () =>
      new RestVideoLibraryStore({
        url: "https://storage.example.com",
        token: "   ",
      }),
    (error) =>
      error.code === "VIDEO_LIBRARY_CONFIGURATION_ERROR" &&
      error.status === 503,
  );
});

test("conflicting writes are retried against the latest article revision", async () => {
  class ConflictingStore extends MemoryVideoLibraryStore {
    conflicts = 0;

    async compareAndSet(key, expectedRaw, value) {
      if (this.conflicts > 0) {
        this.conflicts -= 1;
        const current = this.records.get(key);
        if (current) {
          this.records.set(key, {
            ...current,
            materialRevision: "newer-revision",
            state: "needs_generation",
            asset: null,
          });
        }
        return false;
      }
      return super.compareAndSet(key, expectedRaw, value);
    }
  }

  const store = new ConflictingStore();
  const service = new VideoLibraryService(store);
  const url = "https://iq.wiki/wiki/concurrency";
  const article = {
    title: "Concurrency",
    url,
    rawText: "IQ Wiki explains blockchain concepts with factual, readable articles. ".repeat(8),
  };
  const synced = await service.syncArticle(article);
  store.conflicts = 1;

  await assert.rejects(
    service.publishAsset({
      url,
      revision: synced.revision,
      playbackUrl: "https://cdn.example.com/stale.mp4",
    }),
    (error) => error.code === "STALE_VIDEO_REVISION",
  );
});

test("library preserves minor edits and invalidates material edits", async () => {
  const service = new VideoLibraryService(new MemoryVideoLibraryStore());
  const baseText = `IQ Wiki is a collaborative encyclopedia for blockchain knowledge. Contributors
  research protocols, markets, governance, security, culture, and emerging technology. Readers can
  follow concise explanations, compare related concepts, inspect sources, and discover connected
  projects without navigating fragmented documentation. The platform combines community editing
  with transparent incentives so useful educational material can improve over time. Each article
  aims to turn specialized terminology into an accessible account of how a topic works, why it
  matters, which tradeoffs shape it, and where a curious reader should continue learning.`;
  const article = {
    title: "IQ Wiki",
    url: "https://iq.wiki/wiki/iq-wiki",
    rawText: baseText,
  };

  const firstSync = await service.syncArticle(article);
  assert.equal(firstSync.state, "needs_generation");

  const published = await service.publishAsset({
    url: article.url,
    revision: firstSync.revision,
    playbackUrl: "https://cdn.example.com/iq-wiki.mp4",
    posterUrl: "https://cdn.example.com/iq-wiki.jpg",
    provider: "future-provider",
    model: "future-model",
  });
  assert.equal(published.state, "ready");
  assert.equal(published.asset.durationSeconds, 15);

  const unchanged = await service.syncArticle({
    ...article,
    rawText: `${baseText} Minor clarification.`,
  });
  assert.equal(unchanged.state, "ready");
  assert.equal(unchanged.asset.playbackUrl, published.asset.playbackUrl);

  const changed = await service.syncArticle({ ...article, title: "IQ Wiki Protocol" });
  assert.equal(changed.state, "needs_generation");
  assert.equal(changed.asset, null);

  await assert.rejects(
    service.publishAsset({
      url: article.url,
      revision: firstSync.revision,
      playbackUrl: "https://cdn.example.com/stale.mp4",
    }),
    (error) => error.code === "STALE_VIDEO_REVISION",
  );
});
