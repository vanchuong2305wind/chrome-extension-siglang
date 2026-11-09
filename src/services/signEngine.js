/**
 * signEngine.js
 * Bộ máy tra cứu từ điển và phân tích văn bản tiếng Việt sang chuỗi ký hiệu (Gloss)
 * chạy 100% trên trình duyệt (Client-side) với tốc độ O(1):
 *   - Sử dụng First-Word Index Map thay vì quét 1900 cụm từ mỗi ký tự.
 *   - Tự động BỎ QUA hoàn toàn các từ không có trong từ điển (không giữ token rác,
 *     không đánh vần từng chữ cái làm chậm mô hình 3D).
 */

/**
 * Bảng mở rộng từ đồng nghĩa & phương ngữ tiếng Việt sang Gloss chuẩn trong bộ 2000 từ WLASL
 */
const VIETNAMESE_SYNONYM_TO_GLOSS = {
  // Cảm xúc & tính cách
  'vui': 'happy',
  'vui vẻ': 'happy',
  'vui mừng': 'happy',
  'hạnh phúc': 'happy',
  'buồn': 'sad',
  'buồn bã': 'sad',
  'giận': 'angry',
  'tức giận': 'angry',
  'giận dữ': 'angry',
  'nóng giận': 'angry',
  'hờn': 'angry',
  'hờn giận': 'angry',
  'hơn giận': 'angry',
  'hồn ghép': 'hate',
  'ghét': 'hate',
  'căm ghét': 'hate',
  'thương': 'love',
  'yêu': 'love',
  'yêu thương': 'love',
  'hiền': 'friendly',
  'hiền lành': 'friendly',
  'thân thiện': 'friendly',
  'nóng tính': 'angry',
  'nóng': 'hot',
  'nghi ngờ': 'suspect',
  'nghi': 'doubt',
  'yên tâm': 'calm',
  'an tâm': 'calm',
  'bình tĩnh': 'calm',
  'hiểu': 'understand',
  'không hiểu': 'understand',
  'thích': 'like',
  'không thích': 'dislike',
  'ghen': 'jealous',
  'ghen tị': 'jealous',
  'gen': 'jealous',
  'thông cảm': 'sympathy',
  'đồng cảm': 'sympathy',
  'tình cảm': 'feel',
  'cảm xúc': 'emotion',
  'biểu hiện': 'show',
  'sợ': 'afraid',
  'lo sợ': 'afraid',
  'sợ hãi': 'scared',
  'hồi hộp': 'nervous',
  'lo lắng': 'nervous',
  'xấu hổ': 'shy',
  'mắc cỡ': 'shy',
  'ngại': 'shy',
  'nhớ': 'remember',
  'nhớ nhung': 'miss',
  'tò mò': 'curious',
  'ngạc nhiên': 'surprise',
  'bất ngờ': 'surprise',
  'chấp nhận': 'accept',
  'đồng ý': 'agree',
  'biết': 'know',
  'không biết': 'know',

  // Đại từ & giao tiếp thông dụng
  'mình': 'me',
  'tớ': 'me',
  'tôi': 'me',
  'chúng mình': 'we',
  'chúng tôi': 'we',
  'mọi người': 'people',
  'các bạn': 'you',
  'bạn': 'you',
  'xin chào': 'hello',
  'chào': 'hello',
  'tạm biệt': 'goodbye',
  'hẹn gặp lại': 'later',
  'cảm ơn': 'thank you',
  'cám ơn': 'thank you',
  'xin lỗi': 'sorry',
  'ký hiệu': 'sign',
  'ngôn ngữ ký hiệu': 'sign',
  'người điếc': 'deaf',
  'khiếm thính': 'deaf',
  'bắt đầu': 'start',
  'kết thúc': 'finish',
  'tiếp theo': 'next',
  'theo dõi': 'watch',
  'cố gắng': 'try',
  'tham gia': 'join',
  'buổi học': 'class',
  'bài học': 'lesson',
};

// Các từ đệm / hư từ nếu đứng lẻ thì bỏ qua để câu ký hiệu nhanh, gọn, đúng trọng tâm
const SKIP_FUNCTION_WORDS = new Set([
  'ạ', 'nhé', 'nha', 'ơi', 'à', 'ừ', 'hả', 'nhỉ',
  'thì', 'mà', 'là', 'của', 'cái', 'đó', 'này', 'kia',
  'được', 'bị', 'rồi', 'rất', 'quá', 'lắm',
  'những', 'các', 'một số', 'về', 'nên', 'nếu', 'cùng', 'từ', 'tại', 'đây', 'sẽ', 'để', 'đã',
  'r', 'a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 's', 't', 'u', 'v', 'x', 'y',
]);

function resolveExtensionUrl(relativePath) {
  const clean = relativePath.replace(/^\//, '');
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(clean);
  }
  return `./${clean}`;
}

class ClientSignDictionary {
  constructor() {
    this.viToGloss = {};
    this.glossToVi = {};
    this.availableGlosses = new Set();
    // Map<firstSyllable, Array<{ words: string[], phrase: string, gloss: string }>>
    this.firstWordIndex = new Map();
    this.loaded = false;
    this._loadingPromise = null;
  }

  async load() {
    if (this.loaded) return;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      const [viRes, glossRes] = await Promise.all([
        fetch(resolveExtensionUrl('data/vi_to_gloss.json')),
        fetch(resolveExtensionUrl('data/gloss_to_vi.json')),
      ]);

      if (!viRes.ok || !glossRes.ok) {
        throw new Error('Không thể tải dữ liệu từ điển ngôn ngữ ký hiệu.');
      }

      const rawViToGloss = await viRes.json();
      this.glossToVi = await glossRes.json();
      this.availableGlosses = new Set(Object.keys(this.glossToVi));

      this.viToGloss = { ...rawViToGloss };
      for (const [viKey, targetGloss] of Object.entries(VIETNAMESE_SYNONYM_TO_GLOSS)) {
        if (this.availableGlosses.has(targetGloss)) {
          this.viToGloss[viKey] = targetGloss;
        }
      }

      // Xây dựng chỉ mục theo âm tiết đầu tiên (O(1) Lookup)
      this.firstWordIndex.clear();
      for (const [phrase, gloss] of Object.entries(this.viToGloss)) {
        const cleanPhrase = phrase.toLowerCase().trim();
        if (!cleanPhrase || SKIP_FUNCTION_WORDS.has(cleanPhrase)) continue;
        if (!this.availableGlosses.has(gloss)) continue;

        const words = cleanPhrase.split(/\s+/);
        const first = words[0];
        if (!this.firstWordIndex.has(first)) {
          this.firstWordIndex.set(first, []);
        }
        this.firstWordIndex.get(first).push({
          words,
          phrase: cleanPhrase,
          gloss,
        });
      }

      // Trong mỗi nhóm âm tiết đầu, sắp xếp cụm nhiều từ trước (Greedy Longest-Match)
      for (const list of this.firstWordIndex.values()) {
        list.sort((a, b) => b.words.length - a.words.length);
      }

      this.loaded = true;
    })();

    return this._loadingPromise;
  }

  /**
   * Tách câu tốc độ cao O(N) theo mảng âm tiết và CHỈ GIỮ LẠI các từ có trong từ điển.
   * Những từ không có trong bộ từ điển được bỏ qua hoàn toàn.
   */
  tokenizeMatchedOnly(rawText) {
    const clean = (rawText || '')
      .toLowerCase()
      .replace(/\[.*?\]/g, ' ')
      .replace(/[.,!?;:()"“”'’[\]{}<>\/\\|_+=~`@#$%^&*-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!clean) return [];

    const words = clean.split(' ');
    const matchedTokens = [];
    let i = 0;

    while (i < words.length) {
      const w = words[i];
      if (!w || SKIP_FUNCTION_WORDS.has(w)) {
        i += 1;
        continue;
      }

      const candidates = this.firstWordIndex.get(w);
      let matched = null;

      if (candidates) {
        for (const cand of candidates) {
          const len = cand.words.length;
          if (i + len > words.length) continue;
          let allMatch = true;
          for (let k = 1; k < len; k++) {
            if (words[i + k] !== cand.words[k]) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            matched = cand;
            break;
          }
        }
      }

      if (matched) {
        matchedTokens.push({
          vi: matched.phrase,
          gloss: matched.gloss,
          found: true,
        });
        i += matched.words.length;
      } else if (this.availableGlosses.has(w) && !SKIP_FUNCTION_WORDS.has(w)) {
        // Hỗ trợ trường hợp người dùng nhập/nói từ tiếng Anh có trong bộ 2000 từ
        matchedTokens.push({
          vi: this.glossToVi[w] || w,
          gloss: w,
          found: true,
        });
        i += 1;
      } else {
        // Từ không có trong từ điển -> Bỏ qua hoàn toàn theo yêu cầu
        i += 1;
      }
    }

    return matchedTokens;
  }
}

export const signDict = new ClientSignDictionary();

// Bộ nhớ đệm kết quả dịch câu để gọi lại tốn 0ms
const sentenceCache = new Map();

/**
 * Chuyển đổi văn bản tiếng Việt sang danh sách các ký hiệu 3D.
 * Chỉ trả về các từ CÓ trong từ điển (bỏ qua hoàn toàn từ ngoài từ điển).
 */
export async function translateTextToSigns(text, { dedupeConsecutive = true } = {}) {
  const cleanText = (text || '').replace(/\[.*?\]/g, '').trim();
  if (!cleanText) {
    return {
      input_text: '',
      signs: [],
      found_count: 0,
      total_count: 0,
      method: 'fast_dict',
    };
  }

  const cacheKey = `${cleanText.toLowerCase()}|${dedupeConsecutive ? 1 : 0}`;
  if (sentenceCache.has(cacheKey)) {
    return sentenceCache.get(cacheKey);
  }

  await signDict.load();

  const rawMatched = signDict.tokenizeMatchedOnly(cleanText);
  const finalSigns = [];

  for (const token of rawMatched) {
    if (
      dedupeConsecutive &&
      finalSigns.length > 0 &&
      finalSigns[finalSigns.length - 1].gloss === token.gloss
    ) {
      continue;
    }
    finalSigns.push(token);
  }

  const response = {
    input_text: cleanText,
    signs: finalSigns,
    found_count: finalSigns.length,
    total_count: finalSigns.length,
    method: 'fast_dict',
  };

  if (sentenceCache.size > 500) {
    const firstKey = sentenceCache.keys().next().value;
    sentenceCache.delete(firstKey);
  }
  sentenceCache.set(cacheKey, response);

  return response;
}

export { resolveExtensionUrl };
