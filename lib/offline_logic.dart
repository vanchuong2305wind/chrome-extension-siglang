import 'dart:convert';

const _wordCharacters = r'\p{L}\p{M}\p{N}';
final _wordPattern = RegExp('[$_wordCharacters]+', unicode: true);
final _spacing = RegExp(r'\s+', unicode: true);

class SignToken {
  const SignToken(this.vi, this.gloss);
  final String vi;
  final String? gloss;

  Map<String, Object?> toJson({bool online = false}) => {
    'vi': vi,
    'gloss': gloss,
    'found': gloss != null,
    'online': online,
  };
}

List<SignToken>? parseApiSigns(String? source) {
  if (source == null) return null;
  try {
    final result = jsonDecode(source);
    if (result is! List || result.isEmpty) return null;
    final tokens = <SignToken>[];
    final validGloss = RegExp(r'^vsl-[a-f0-9]{20}$');
    for (final item in result) {
      if (item is! Map || item['vi'] is! String || item['found'] is! bool) {
        return null;
      }
      final gloss = item['gloss'];
      if (item['found'] == true &&
          (gloss is! String || !validGloss.hasMatch(gloss))) {
        return null;
      }
      tokens.add(
        SignToken(
          item['vi'] as String,
          item['found'] == true ? gloss as String : null,
        ),
      );
    }
    return tokens;
  } on FormatException {
    return null;
  }
}

class SignDictionary {
  SignDictionary(Map<String, String> entries, Map<String, String> aliases)
    : _entries = {
        for (final alias in aliases.entries)
          if (entries.containsKey(alias.value))
            alias.key: entries[alias.value]!,
        ...entries,
      } {
    final phrases = _entries.keys.toList()
      ..sort((a, b) => b.length.compareTo(a.length));
    if (phrases.isNotEmpty) {
      final choices = phrases.map(RegExp.escape).join('|');
      _phrasePattern = RegExp(
        '(?<![$_wordCharacters])(?:$choices)(?![$_wordCharacters])',
        unicode: true,
      );
    }
  }

  factory SignDictionary.fromJson(String source) {
    final json = jsonDecode(source) as Map<String, dynamic>;
    return SignDictionary(
      Map<String, String>.from(json['entries'] as Map),
      Map<String, String>.from(json['aliases'] as Map),
    );
  }

  final Map<String, String> _entries;
  RegExp? _phrasePattern;

  // Android composes Unicode with java.text.Normalizer before lookup.
  List<SignToken> tokenize(String composedText) {
    final text = composedText
        .toLowerCase()
        .replaceAll('_', ' ')
        .replaceAll(_spacing, ' ')
        .trim();
    final result = <SignToken>[];
    void addUnknown(String span) {
      result.addAll(
        _wordPattern
            .allMatches(span)
            .map((match) => SignToken(match.group(0)!, null)),
      );
    }

    var cursor = 0;
    for (final match
        in _phrasePattern?.allMatches(text) ?? const <RegExpMatch>[]) {
      addUnknown(text.substring(cursor, match.start));
      final phrase = match.group(0)!;
      result.add(SignToken(phrase, _entries[phrase]));
      cursor = match.end;
    }
    addUnknown(text.substring(cursor));
    return result;
  }
}

String proposeSentence(Iterable<String> words) {
  final cleaned = words
      .map((word) => word.split('/').first.replaceAll(_spacing, ' ').trim())
      .where((word) => word.isNotEmpty)
      .join(' ');
  if (cleaned.isEmpty) return '';
  return '${cleaned[0].toUpperCase()}${cleaned.substring(1)}.';
}

class RecognizedSigns {
  final _events = <String>{};
  final _words = <String>[];

  List<String> get words => List.unmodifiable(_words);

  bool accept(String event, String word, double confidence, double margin) {
    if (confidence < .45 || margin < .12 || !_events.add(event)) return false;
    _words.add(word);
    return true;
  }

  void removeLast() {
    if (_words.isNotEmpty) _words.removeLast();
  }

  void clear() => _words.clear();
}
