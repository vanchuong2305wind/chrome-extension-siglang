import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:signlang/main.dart';
import 'package:signlang/paper.dart';

void main() {
  testWidgets('home offers both offline workflows in Vietnamese', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const SignLangApp());
    expect(find.text('Xin chào!'), findsOneWidget);
    expect(find.text('Giọng nói sang ký hiệu'), findsOneWidget);
    expect(find.text('Camera sang văn bản'), findsOneWidget);
    expect(find.text('Dịch'), findsOneWidget);
    expect(find.text('Camera'), findsOneWidget);

    Rect card(String title) => tester.getRect(
      find.ancestor(of: find.text(title), matching: find.byType(SketchCard)),
    );

    for (final scale in [1.0, 2.0]) {
      if (scale == 2.0) {
        tester.view.physicalSize = const Size(390, 1400);
      }
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      await tester.pump();
      final speech = card('Dịch giọng nói');
      final camera = card('Nhận diện');
      expect(camera.size, speech.size);
      expect(camera.left, speech.left);
      expect(camera.top, greaterThan(speech.bottom));
      expect(speech.width, greaterThan(speech.height));
    }
  });
}
