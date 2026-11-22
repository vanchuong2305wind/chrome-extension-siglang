/**
 * viesignEngine.js
 * Dịch tiếng Việt sang chuỗi ký hiệu bằng bộ dữ liệu VieSign (ngôn ngữ ký hiệu Việt Nam),
 * chạy 100% trên trình duyệt.
 *
 * Dữ liệu `data/viesign/dictionary.json` được xuất từ backend signlangue bằng
 * `signlangue/scripts/export_viesign_to_extension.py`, nên từ điển, mã ký hiệu (vsl-…),
 * alias và file landmark giống hệt tab "3D Avatar" của signlangue.
 *
 * Cách tách từ mô phỏng đường rule-based của backend (`text_parser.parse_rule_based` +
 * `SignDictionary.longest_match_tokenize`): chuẩn hoá NFC + chữ thường, khớp cụm dài nhất,
 * không khớp xuyên dấu câu. Chỉ trả về các từ CÓ trong từ điển, như signEngine cũ.
 */

import { resolveExtensionUrl } from './signEngine';

const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}_]';

/** Giống `viesign_dataset.normalize_word` của backend. */
export function normalizeWord(text) {
  return (text || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class VieSignDictionary {
  constructor() {
    this.entries = {};
    this.viToGloss = new Map();
    this.aliases = new Map();
    this.pattern = null;
    this.loaded = false;
    this._loadingPromise = null;
  }

  async load() {
    if (this.loaded) return;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      const resp = await fetch(resolveExtensionUrl('data/viesign/dictionary.json'));
      if (!resp.ok) throw new Error('Không thể tải từ điển VieSign.');
      const dict = await resp.json();
      if (dict.dataset !== 'viesign') throw new Error('Từ điển không phải dữ liệu VieSign.');

      this.entries = dict.entries || {};
      this.viToGloss.clear();
      for (const [identifier, entry] of Object.entries(this.entries)) {
        this.viToGloss.set(normalizeWord(entry.vi), identifier);
      }
      this.aliases = new Map(
        Object.entries(dict.aliases || {}).filter(([, target]) => this.viToGloss.has(target))
      );

      const phrases = [...new Set([...this.viToGloss.keys(), ...this.aliases.keys()])].sort(
        (a, b) => b.length - a.length
      );
      this.pattern = phrases.length
        ? new RegExp(
            `(?<!${WORD_CHAR})(?:${phrases.map(escapeRegExp).join('|')})(?!${WORD_CHAR})`,
            'gu'
          )
        : null;
      this.loaded = true;
    })();

    try {
      return await this._loadingPromise;
    } catch (err) {
      this._loadingPromise = null;
      throw err;
    }
  }

  /** Giống `SignDictionary.lookup_vietnamese`. */
  lookup(phrase) {
    const word = normalizeWord(phrase);
    let identifier = this.viToGloss.get(word);
    let matchedVi = word;
    if (!identifier && this.aliases.has(word)) {
      matchedVi = this.aliases.get(word);
      identifier = this.viToGloss.get(matchedVi);
    }
    if (!identifier) return null;
    const entry = this.entries[identifier];
    return {
      vi: word,
      gloss: identifier,
      found: true,
      language: entry.language,
      landmark: entry.landmark,
      ...(matchedVi !== word ? { match: 'alias', matched_vi: matchedVi } : {}),
    };
  }

  /** Các cụm khớp dài nhất, theo thứ tự trong câu. */
  tokenizeMatchedOnly(rawText) {
    const text = normalizeWord(rawText);
    if (!text || !this.pattern) return [];
    const tokens = [];
    for (const match of text.matchAll(this.pattern)) {
      const token = this.lookup(match[0]);
      if (token) tokens.push(token);
    }
    return tokens;
  }
}

export const viesignDict = new VieSignDictionary();

const sentenceCache = new Map();

/** Cùng định dạng kết quả với `translateTextToSigns` của signEngine cũ. */
export async function translateTextToVieSigns(text) {
  const cleanText = (text || '').replace(/\[.*?\]/g, '').trim();
  if (!cleanText) {
    return { input_text: '', signs: [], found_count: 0, total_count: 0, method: 'viesign_dict' };
  }

  const cacheKey = normalizeWord(cleanText);
  if (sentenceCache.has(cacheKey)) return sentenceCache.get(cacheKey);

  await viesignDict.load();
  const signs = viesignDict.tokenizeMatchedOnly(cleanText);
  const response = {
    input_text: cleanText,
    signs,
    found_count: signs.length,
    total_count: signs.length,
    method: 'viesign_dict',
  };

  if (sentenceCache.size > 500) sentenceCache.delete(sentenceCache.keys().next().value);
  sentenceCache.set(cacheKey, response);
  return response;
}
