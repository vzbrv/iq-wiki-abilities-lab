import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryVideoLibraryStore,
  VideoLibraryService,
  classifyArticleChange,
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
