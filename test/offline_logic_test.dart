import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:signlang/offline_logic.dart';

void main() {
  final dictionary = SignDictionary.fromJson(
    File('android/app/src/main/assets/signs/dictionary.json')
        .readAsStringSync(),
  );

  test('finds the longest accented phrase without crossing punctuation', () {
    final tokens = dictionary.tokenize('XIN CHÀO, Bệnh   viện! Bệnh, viện.');
    expect(tokens.take(2).map((token) => token.vi), ['xin chào', 'bệnh viện']);
    expect(tokens.take(2).every((token) => token.gloss != null), isTrue);
    expect(tokens.skip(2).map((token) => token.vi), ['bệnh', 'viện']);
    expect(
      dictionary.tokenize('xin_chào').single.gloss,
      'vsl-8aaecd06d85c7f743d35',
    );
    expect(
      dictionary.tokenize('cảm ơn').single.gloss,
      'vsl-def27973aeed2adc7fdf',
    );
    expect(dictionary.tokenize('qzẻq').single.gloss, isNull);
    expect(
      dictionary.tokenize('sự giúp đỡ').single.gloss,
      dictionary.tokenize('giúp đỡ').single.gloss,
    );
  });

  test('reads server signs and keeps unknown words visible', () {
    final signs = parseApiSigns(
      '[{"vi":"bệnh viện","gloss":"vsl-d364408233d68ac752ef","found":true},'
      '{"vi":"qzẻq","gloss":null,"found":false}]',
    );
    expect(signs?.first.toJson(online: true)['online'], isTrue);
    expect(signs?.last.gloss, isNull);
    expect(
      parseApiSigns('[{"vi":"a","gloss":"../file","found":true}]'),
      isNull,
    );
  });

  test('marks missing targets and resolves valid aliases', () {
    final sample = SignDictionary(
      {'chào': 'real'},
      {'xin chào': 'chào', 'xa': 'missing'},
    );
    expect(sample.tokenize('xin chào').single.gloss, 'real');
    expect(sample.tokenize('xa').single.gloss, isNull);
  });

  test(
    'accepts one result per event and keeps negation and separate repeats',
    () {
      final signs = RecognizedSigns();
      expect(signs.accept('1', 'tôi', .44, .13), isFalse);
      expect(signs.accept('1', 'tôi', .45, .12), isTrue);
      expect(signs.accept('1', 'tôi', .91, .66), isFalse);
      expect(signs.accept('2', 'không', .80, .10), isFalse);
      expect(signs.accept('2', 'không', .80, .50), isTrue);
      expect(signs.accept('3', 'không', .80, .50), isTrue);
      expect(signs.accept('4', 'uống / đồ uống', .91, .66), isTrue);
      expect(proposeSentence(signs.words), 'Tôi không không uống.');
    },
  );
}
