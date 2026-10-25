// lib/match.js — pure text matching shared by content.js and the tests.
//
// No DOM, no chrome.*: loaded as a classic script before content.js, and
// require()d directly by test/match.test.cjs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XbmMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Words that carry no topical signal. Subject terms only.
  const STOPWORDS = new Set(
    (
      'a about above after again against all also am an and any are as at be because been before being ' +
      'below between both but by can could did do does doing done don down during each even ever every few ' +
      'for from further get gets getting go going got had has have having he her here hers herself him ' +
      'himself his how i if in into is it its itself just know let like lot made make making many may me ' +
      'might more most much must my myself need new no nor not now of off on once one only or other ought ' +
      'our ours ourselves out over own same say says see she should so some something still such take than ' +
      'that the their theirs them themselves then there these they thing things think this those though ' +
      'through to too under until up us use used using very via want was way we well were what when where ' +
      'which while who whom why will with would you your yours yourself yourselves ' +
      'ain aren couldn didn doesn hadn hasn haven isn mustn shan shouldn wasn weren won wouldn ' +
      'actually basically honestly literally maybe probably really someone anyone everyone somebody nobody ' +
      'people stuff gonna wanna okay yeah understand understands understood mean means matter matters ' +
      'happen happens happened feel feels felt look looks seem seems keep keeps start starts started ' +
      'trying tries tried hello hey hi chat please thanks thank guys bro lol haha cool nice ' +
      'lmao rofl omg wtf bruh dude folks yall ' +
      'pretty especially ways bit kind sort'
    ).split(' ')
  );

  // Latin words stay whitespace-delimited. CJK is handled separately, as
  // overlapping bigrams, because those scripts are written without spaces.
  const NOT_WORD = /[^a-z0-9\u00c0-\u024f ]+/g;
  const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g;

  const RELATED_MIN = 0.12;
  const MIN_SHARED = 2;
  const MIN_TOKENS = 4;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[@#]\w+/g, ' ');
  }

  function tokenize(text) {
    if (!text) return [];
    const source = normalize(text);

    const tokens = source
      .replace(NOT_WORD, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

    // "产品想做" -> 产品, 品想. Never the whole run: a ten-character sentence is
    // not a term, and keeping it would dilute every cosine score.
    const runs = source.match(CJK_RUN) || [];
    for (const run of runs) {
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    }
    return tokens;
  }

  function buildCorpus(bookmarks) {
    const df = new Map();
    for (const bm of bookmarks) {
      for (const term of new Set(tokenize(bm.text))) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }
    return {
      df,
      n: bookmarks.length,
      maxDf: Math.max(3, bookmarks.length * 0.04),
    };
  }

  function idf(term, corpus) {
    return Math.log((corpus.n + 1) / ((corpus.df.get(term) || 0) + 1)) + 0.15;
  }

  function vector(tokens, corpus) {
    const vec = new Map();
    for (const term of tokens) {
      if ((corpus.df.get(term) || 0) > corpus.maxDf) continue;
      vec.set(term, (vec.get(term) || 0) + idf(term, corpus));
    }
    return vec;
  }

  function cosine(a, b) {
    if (!a.size || !b.size) return 0;
    let dot = 0;
    for (const [term, weight] of a) {
      const other = b.get(term);
      if (other) dot += weight * other;
    }
    if (!dot) return 0;
    let na = 0;
    let nb = 0;
    for (const weight of a.values()) na += weight * weight;
    for (const weight of b.values()) nb += weight * weight;
    return dot / Math.sqrt(na * nb);
  }

  function sharedTerms(a, b, limit) {
    const hits = [];
    for (const term of a.keys()) if (b.has(term)) hits.push(term);
    return hits.sort((x, y) => (b.get(y) || 0) - (b.get(x) || 0)).slice(0, limit);
  }

  // Returns the best bookmark that clears both the term requirement and the
  // score floor, or null. Candidates are filtered by shared terms *before*
  // scoring so the winner is never a high score with a single shared word.
  function pickBest(opts) {
    const context = vector(opts.contextTokens, opts.corpus);
    if (!context.size) return null;

    const minScore = opts.minScore === undefined ? RELATED_MIN : opts.minScore;
    const minShared = opts.minShared === undefined ? MIN_SHARED : opts.minShared;
    const minTokens = opts.minTokens === undefined ? MIN_TOKENS : opts.minTokens;

    let best = null;
    for (const bm of opts.pool) {
      const vec = opts.vectorOf(bm);
      if (!vec || vec.size < minTokens) continue;
      // Counting shared terms is enough to filter, and it avoids allocating and
      // sorting a fresh array for every candidate. The pool is the whole cache —
      // 5,899 entries on a full one — so that sort was most of the pick.
      let shared = 0;
      for (const term of vec.keys()) {
        if (context.has(term)) shared++;
        if (shared >= minShared) break;
      }
      if (shared < minShared) continue;
      const score = cosine(context, vec);
      if (!best || score > best.score) best = { bm, vec, score };
    }

    if (!best || best.score < minScore) return null;
    return { bm: best.bm, score: best.score, terms: sharedTerms(best.vec, context, 2) };
  }

  return {
    STOPWORDS,
    tokenize,
    buildCorpus,
    vector,
    cosine,
    sharedTerms,
    pickBest,
    RELATED_MIN,
    MIN_SHARED,
    MIN_TOKENS,
  };
});
